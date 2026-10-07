(function () {
    'use strict';

    /*
     * LexApi
     * Версия: 1
     *
     * Назначение:
     * - тонкий клиент Cloudflare Worker lex-api;
     * - /suggest, /support — замена прямой отправки на вебхук Discord;
     * - /stats — отправка анонимной статистики;
     * - единый формат результата { ok:true } / { ok:false, error }.
     *
     * Коды ошибок, которые возвращает этот модуль:
     *   unavailable    — Worker URL не задан
     *   network        — сеть недоступна, DNS, TLS, обрыв
     *   timeout        — ответа не было 15 секунд
     *   origin         — Worker отклонил Origin (403)
     *   too_large      — тело больше лимита Worker
     *   rate_limited   — слишком много запросов (429 или 503 с Retry-After)
     *   bad_request    — плохой запрос (400)
     *   bad_schema     — не прошла схема (400)
     *   identity_forbidden — в статистике найдены запрещённые ключи
     *   file_type      — недопустимый тип вложения
     *   disabled       — на Worker включён KILL
     *   webhook_invalid— Discord ответил 401/404 (вебхук удалён)
     *   upstream       — ошибка Worker/Discord (5xx)
     *   unknown        — что-то другое
     *
     * Правила:
     * - наружу никогда не бросает;
     * - повторов не делает;
     * - не логирует тела запросов;
     * - не хранит секреты.
     */

    var WORKER_URL = 'https://lex-api.insidex.workers.dev';

    var TIMEOUT_MS = 15000;

    var MAX_EMBEDS = 3;

    var exported = {};

    /* =========================================================
       Базовые helpers
       ========================================================= */

    function isHttpsPage() {
        try {
            return (
                typeof window !== 'undefined' &&
                window.location &&
                window.location.protocol === 'https:'
            );
        } catch (e) {
            return false;
        }
    }

    function safeWorkerUrl() {
        try {
            if (typeof WORKER_URL !== 'string') {
                return null;
            }

            var trimmed = WORKER_URL.replace(/\/+$/, '');

            if (trimmed.indexOf('https://') !== 0) {
                return null;
            }

            return trimmed;
        } catch (e) {
            return null;
        }
    }

    function resultOk(extra) {
        var result = { ok: true };

        if (extra && typeof extra === 'object') {
            for (var key in extra) {
                if (
                    Object.prototype.hasOwnProperty.call(extra, key) &&
                    key !== 'ok'
                ) {
                    result[key] = extra[key];
                }
            }
        }

        return Promise.resolve(result);
    }

    function resultError(code, extra) {
        var result = { ok: false, error: String(code || 'unknown') };

        if (extra && typeof extra === 'object') {
            for (var key in extra) {
                if (
                    Object.prototype.hasOwnProperty.call(extra, key) &&
                    key !== 'ok' &&
                    key !== 'error'
                ) {
                    result[key] = extra[key];
                }
            }
        }

        return Promise.resolve(result);
    }

    /* =========================================================
       Проверка embed (клиентская, до отправки)

       Основная защита всё равно на Worker, здесь только чтобы
       не гонять заведомо плохое тело по сети.
       ========================================================= */

    function isPlainObject(value) {
        return (
            value !== null &&
            typeof value === 'object' &&
            !Array.isArray(value)
        );
    }

    function validateEmbedBasic(embed) {
        if (!isPlainObject(embed)) {
            return false;
        }

        if (
            typeof embed.title !== 'undefined' &&
            (
                typeof embed.title !== 'string' ||
                embed.title.length > 256
            )
        ) {
            return false;
        }

        if (
            typeof embed.description !== 'undefined' &&
            (
                typeof embed.description !== 'string' ||
                embed.description.length > 4096
            )
        ) {
            return false;
        }

        if (
            Array.isArray(embed.fields) &&
            embed.fields.length > 25
        ) {
            return false;
        }

        return true;
    }

    /* =========================================================
       Нормализация вложений

       Принимаем:
       - File / Blob с полем name (для File);
       - { name, blob } — удобный вариант для тестовой страницы,
         потому что name задавать у Blob напрямую нельзя.
       ========================================================= */

    function normalizeAttachment(item, fallbackIndex) {
        try {
            if (typeof File !== 'undefined' && item instanceof File) {
                return {
                    name: item.name || ('file-' + fallbackIndex),
                    blob: item
                };
            }

            if (
                item &&
                typeof item === 'object' &&
                item.blob &&
                typeof item.name === 'string'
            ) {
                return {
                    name: item.name,
                    blob: item.blob
                };
            }

            return null;
        } catch (e) {
            return null;
        }
    }

    /* =========================================================
       Парсинг ответа Worker
       ========================================================= */

    function codeFromStatus(status) {
        if (status === 400) return 'bad_request';
        if (status === 403) return 'origin';
        if (status === 413) return 'too_large';
        if (status === 415) return 'file_type';
        if (status === 429) return 'rate_limited';
        if (status === 503) return 'upstream';
        if (status >= 500) return 'upstream';
        return 'unknown';
    }

    function readResponseBody(response) {
        return response.text().then(
            function (text) {
                if (!text) {
                    return null;
                }

                try {
                    return JSON.parse(text);
                } catch (e) {
                    return null;
                }
            },
            function () {
                return null;
            }
        );
    }

    function interpretResponse(response) {
        return readResponseBody(response).then(function (body) {
            var ok = response.ok;

            if (ok) {
                if (
                    body &&
                    typeof body === 'object' &&
                    body.ok === false
                ) {
                    return {
                        ok: false,
                        error: String(body.error || 'unknown')
                    };
                }

                var extra = {};

                if (
                    body &&
                    typeof body === 'object' &&
                    body.dup === true
                ) {
                    extra.dup = true;
                }

                return {
                    ok: true,
                    extra: extra
                };
            }

            var code =
                body &&
                typeof body === 'object' &&
                typeof body.error === 'string'
                    ? body.error
                    : codeFromStatus(response.status);

            return {
                ok: false,
                error: code
            };
        });
    }

    /* =========================================================
       fetch с таймаутом и без бросания наружу
       ========================================================= */

    function fetchWithTimeout(url, options) {
        return new Promise(function (resolve) {
            var controller = null;
            var timer = null;
            var settled = false;

            function finish(value) {
                if (settled) {
                    return;
                }

                settled = true;

                if (timer !== null) {
                    try {
                        clearTimeout(timer);
                    } catch (e) {
                        /* ignore */
                    }
                }

                resolve(value);
            }

            try {
                if (
                    typeof AbortController === 'function'
                ) {
                    controller = new AbortController();

                    if (
                        options &&
                        typeof options === 'object'
                    ) {
                        options.signal = controller.signal;
                    } else {
                        options = { signal: controller.signal };
                    }
                }
            } catch (e) {
                controller = null;
            }

            timer = setTimeout(function () {
                if (controller) {
                    try {
                        controller.abort();
                    } catch (e) {
                        /* ignore */
                    }
                }

                finish({ ok: false, error: 'timeout' });
            }, TIMEOUT_MS);

            fetch(url, options)
                .then(function (response) {
                    finish({ ok: true, response: response });
                })
                .catch(function (error) {
                    if (
                        error &&
                        (
                            error.name === 'AbortError' ||
                            error.message === 'Aborted' ||
                            error.message === 'The user aborted a request.'
                        )
                    ) {
                        finish({ ok: false, error: 'timeout' });
                        return;
                    }

                    finish({ ok: false, error: 'network' });
                });
        });
    }

    /* =========================================================
       Общая отправка
       ========================================================= */

    function sendJson(path, payload) {
        var base = safeWorkerUrl();

        if (!base) {
            return resultError('unavailable');
        }

        var url = base + path;

        return fetchWithTimeout(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        }).then(function (fetchResult) {
            if (!fetchResult.ok) {
                return resultError(fetchResult.error);
            }

            return interpretResponse(fetchResult.response).then(
                function (interpreted) {
                    if (interpreted.ok) {
                        return resultOk(interpreted.extra);
                    }
                    return resultError(interpreted.error);
                }
            );
        });
    }

    /* =========================================================
       Публичное: available
       ========================================================= */

    function available() {
        return !!safeWorkerUrl();
    }

    /* =========================================================
       Публичное: send(channel, embed, files)

       channel: 'suggest' | 'support'
       embed:   один Discord-embed (объект)
       files:   массив File | { name, blob } (необязательно)

       Порядок действий:
       - нет файлов → JSON { embeds: [embed] } на /<channel>;
       - есть файлы → multipart/form-data с payload_json и files[N];
         embed может ссылаться на вложение через attachment://<name>.
       ========================================================= */

    function send(channel, embed, files) {
        try {
            if (channel !== 'suggest' && channel !== 'support') {
                return resultError('bad_request');
            }

            if (!validateEmbedBasic(embed)) {
                return resultError('bad_schema');
            }

            var base = safeWorkerUrl();

            if (!base) {
                return resultError('unavailable');
            }

            var url = base + '/' + channel;

            var attachments = [];

            if (Array.isArray(files)) {
                for (var i = 0; i < files.length; i += 1) {
                    var normalized = normalizeAttachment(files[i], i);

                    if (!normalized) {
                        return resultError('file_type');
                    }

                    attachments.push(normalized);
                }
            }

            var payload = {
                embeds: [embed]
            };

            /*
             * Без вложений — обычный JSON.
             */
            if (attachments.length === 0) {
                return sendJson(
                    '/' + channel,
                    payload
                );
            }

            /*
             * С вложениями — multipart/form-data.
             */
            var form;

            try {
                form = new FormData();
            } catch (e) {
                return resultError('bad_request');
            }

            try {
                form.append(
                    'payload_json',
                    JSON.stringify(payload)
                );

                for (
                    var j = 0;
                    j < attachments.length;
                    j += 1
                ) {
                    form.append(
                        'files[' + j + ']',
                        attachments[j].blob,
                        attachments[j].name
                    );
                }
            } catch (e) {
                return resultError('bad_request');
            }

            /*
             * Content-Type НЕ ставим: браузер сам выставит
             * multipart boundary.
             */
            return fetchWithTimeout(url, {
                method: 'POST',
                body: form
            }).then(function (fetchResult) {
                if (!fetchResult.ok) {
                    return resultError(fetchResult.error);
                }

                return interpretResponse(fetchResult.response).then(
                    function (interpreted) {
                        if (interpreted.ok) {
                            return resultOk(interpreted.extra);
                        }
                        return resultError(interpreted.error);
                    }
                );
            });
        } catch (e) {
            return resultError('unknown');
        }
    }

    /* =========================================================
       Публичное: stats(payload)

       payload формирует вызывающая сторона — это ровно тот
       JSON, который ожидает Worker на /stats.
       Клиентская валидация минимальна: Worker сделает основную.
       ========================================================= */

    function stats(payload) {
        try {
            if (!isPlainObject(payload)) {
                return resultError('bad_schema');
            }

            return sendJson('/stats', payload);
        } catch (e) {
            return resultError('unknown');
        }
    }

    /* =========================================================
       Экспорт
       ========================================================= */

    exported.available = available;
    exported.send = send;
    exported.stats = stats;

    /*
     * Удобные обёртки, чтобы карточке не собирать embed вручную
     * в двух местах.
     */
    exported.suggest = function (embed, files) {
        return send('suggest', embed, files);
    };

    exported.support = function (embed, files) {
        return send('support', embed, files);
    };

    try {
        if (typeof window !== 'undefined') {
            window.LexApi = exported;
        }
    } catch (e) {
        /* ignore */
    }
})();