(function () {
    'use strict';

    /*
     * LexAuth
     * Версия: 1
     *
     * Назначение:
     * - Discord OAuth через Supabase Auth;
     * - облачные профили;
     * - архив дел;
     * - офлайн-очередь дел;
     * - кеш активного профиля;
     * - безопасное восстановление после перезагрузки.
     *
     * Ошибки:
     * network          — сеть недоступна / запрос не выполнен
     * unavailable      — текущая страница не поддерживает Supabase
     * not_authenticated — пользователь не вошёл
     * auth_failed      — ошибка входа/выхода
     * cancelled        — вход был отменён
     * profile_not_found — профиль не найден
     * profiles_quota  — превышен лимит профилей
     * cases_quota     — превышен лимит дел
     * invalid_data     — некорректные данные
     * data_too_large  — data больше 400000 байт
     * case_not_found  — дело не найдено
     * cloud_error     — ошибка Supabase
     * queue_full      — очередь переполнена
     * local_storage   — localStorage недоступен
     * unknown         — неизвестная ошибка
     *
     * Жёсткое правило:
     * Все публичные методы Promise-based и не выбрасывают ожидаемые ошибки.
     */

    var CFG = {
        url: 'https://acokvcbfxrzfrgppvvzq.supabase.co',
        anon: 'sb_publishable_hlPdJC0PpBVte2Uas1zYQg_YVVeTx7B'
    };

    var SUPABASE_CDN =
        'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';

    var PROFILE_KEY = 'lex_profile';
    var CLOUD_PROFILE_KEY = 'lex_profile_cloud';
    var CASE_QUEUE_KEY = 'lex_cases_queue';

    var MAX_PROFILE_COUNT = 10;
    var MAX_CASE_DATA_BYTES = 400000;
    var MAX_QUEUE = 20;

    var supabaseClient = null;
    var loadPromise = null;
    var initPromise = null;
    var currentUser = null;
    var initialized = false;

    var exported = {};

    /* =========================================================
       Базовые безопасные helpers
       ========================================================= */

    function safeErrorCode(error, fallback) {
        try {
            if (!error) {
                return fallback || 'unknown';
            }

            var message = String(error.message || '').toLowerCase();
            var code = String(error.code || '').toLowerCase();

            if (
                message.indexOf('network') !== -1 ||
                message.indexOf('fetch') !== -1 ||
                message.indexOf('failed to fetch') !== -1 ||
                code === 'network_error'
            ) {
                return 'network';
            }

            if (
                message.indexOf('cancel') !== -1 ||
                message.indexOf('denied') !== -1
            ) {
                return 'cancelled';
            }

            if (
                message.indexOf('quota') !== -1 &&
                message.indexOf('profiles') !== -1
            ) {
                return 'profiles_quota';
            }

            if (
                message.indexOf('quota') !== -1 &&
                message.indexOf('cases') !== -1
            ) {
                return 'cases_quota';
            }

            if (
                message.indexOf('not found') !== -1 &&
                message.indexOf('profile') !== -1
            ) {
                return 'profile_not_found';
            }

            if (
                message.indexOf('not found') !== -1 &&
                message.indexOf('case') !== -1
            ) {
                return 'case_not_found';
            }

            if (
                message.indexOf('invalid') !== -1 &&
                message.indexOf('data') !== -1
            ) {
                return 'invalid_data';
            }

            if (
                code === '23505' ||
                message.indexOf('duplicate') !== -1
            ) {
                return 'cloud_error';
            }

            return fallback || 'unknown';
        } catch (e) {
            return fallback || 'unknown';
        }
    }

    function resultOk(data) {
        if (typeof data === 'undefined') {
            return Promise.resolve({ ok: true });
        }

        return Promise.resolve({
            ok: true,
            data: data
        });
    }

    function resultError(code, extra) {
        var result = {
            ok: false,
            error: code
        };

        if (extra && typeof extra === 'object') {
            for (var key in extra) {
                if (
                    Object.prototype.hasOwnProperty.call(extra, key) &&
                    key !== 'error'
                ) {
                    result[key] = extra[key];
                }
            }
        }

        return Promise.resolve(result);
    }

    function dispatchChange(reason) {
        try {
            if (
                typeof window !== 'undefined' &&
                typeof window.dispatchEvent === 'function' &&
                typeof window.CustomEvent === 'function'
            ) {
                window.dispatchEvent(
                    new CustomEvent('lex-auth-change', {
                        detail: {
                            reason: String(reason || 'unknown')
                        }
                    })
                );
            }
        } catch (e) {
            /* Ошибка события не должна ломать Lex. */
        }
    }

    /* =========================================================
       localStorage
       ========================================================= */

    function storageGet(key) {
        try {
            if (
                typeof window === 'undefined' ||
                !window.localStorage
            ) {
                return {
                    ok: false,
                    error: 'local_storage'
                };
            }

            return {
                ok: true,
                value: window.localStorage.getItem(key)
            };
        } catch (e) {
            return {
                ok: false,
                error: 'local_storage'
            };
        }
    }

    function storageSet(key, value) {
        try {
            if (
                typeof window === 'undefined' ||
                !window.localStorage
            ) {
                return false;
            }

            window.localStorage.setItem(key, value);
            return true;
        } catch (e) {
            return false;
        }
    }

    function storageRemove(key) {
        try {
            if (
                typeof window === 'undefined' ||
                !window.localStorage
            ) {
                return;
            }

            window.localStorage.removeItem(key);
        } catch (e) {
            /* Молча отключаем локальную часть. */
        }
    }

    function parseStored(key, fallback) {
        var item = storageGet(key);

        if (!item.ok || !item.value) {
            return fallback;
        }

        try {
            return JSON.parse(item.value);
        } catch (e) {
            storageRemove(key);
            return fallback;
        }
    }

    /* =========================================================
       Страница / HTTPS
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

    /* =========================================================
       Размер JSON
       ========================================================= */

    function utf8ByteLength(value) {
        try {
            var text = typeof value === 'string'
                ? value
                : JSON.stringify(value);

            if (typeof TextEncoder === 'function') {
                return new TextEncoder().encode(text).length;
            }

            /*
             * Fallback для старых браузеров.
             */
            return unescape(encodeURIComponent(text)).length;
        } catch (e) {
            return -1;
        }
    }

    /* =========================================================
       Supabase CDN
       ========================================================= */

    function loadSupabase() {
        if (!isHttpsPage()) {
            return Promise.resolve({
                ok: false,
                error: 'unavailable'
            });
        }

        if (
            supabaseClient &&
            typeof supabaseClient.from === 'function'
        ) {
            return Promise.resolve({
                ok: true
            });
        }

        if (loadPromise) {
            return loadPromise;
        }

        loadPromise = new Promise(function (resolve) {
            try {
                if (
                    typeof window === 'undefined' ||
                    !window.document
                ) {
                    resolve({
                        ok: false,
                        error: 'unavailable'
                    });
                    return;
                }

                /*
                 * Если Supabase уже присутствует на странице,
                 * повторно CDN не загружаем.
                 */
                if (
                    window.supabase &&
                    typeof window.supabase.createClient === 'function'
                ) {
                    try {
                        supabaseClient = window.supabase.createClient(
                            CFG.url,
                            CFG.anon,
                            {
                                auth: {
                                    persistSession: true,
                                    autoRefreshToken: true,
                                    detectSessionInUrl: true,
                                    flowType: 'pkce'
                                }
                            }
                        );

                        resolve({
                            ok: true
                        });
                        return;
                    } catch (e1) {
                        resolve({
                            ok: false,
                            error: 'unavailable'
                        });
                        return;
                    }
                }

                var script = document.createElement('script');

                script.async = true;
                script.src = SUPABASE_CDN;

                script.onload = function () {
                    try {
                        if (
                            !window.supabase ||
                            typeof window.supabase.createClient !==
                                'function'
                        ) {
                            resolve({
                                ok: false,
                                error: 'unavailable'
                            });
                            return;
                        }

                        supabaseClient =
                            window.supabase.createClient(
                                CFG.url,
                                CFG.anon,
                                {
                                    auth: {
                                        persistSession: true,
                                        autoRefreshToken: true,
                                        detectSessionInUrl: true,
                                        flowType: 'pkce'
                                    }
                                }
                            );

                        resolve({
                            ok: true
                        });
                    } catch (e2) {
                        resolve({
                            ok: false,
                            error: 'unavailable'
                        });
                    }
                };

                script.onerror = function () {
                    resolve({
                        ok: false,
                        error: 'network'
                    });
                };

                (
                    document.head ||
                    document.documentElement ||
                    document.body
                ).appendChild(script);
            } catch (e) {
                resolve({
                    ok: false,
                    error: 'unavailable'
                });
            }
        });

        return loadPromise;
    }

    /* =========================================================
       Инициализация
       ========================================================= */

    function init() {
        if (initPromise) {
            return initPromise;
        }

        initPromise = new Promise(function (resolve) {
            loadSupabase()
                .then(function (loaded) {
                    if (!loaded.ok) {
                        initialized = true;
                        resolve({
                            ok: false,
                            error: loaded.error
                        });
                        return;
                    }

                    try {
                        supabaseClient.auth.onAuthStateChange(
                            function (event, session) {
                                try {
                                    currentUser =
                                        session &&
                                        session.user
                                            ? session.user
                                            : null;

                                    if (
                                        event === 'SIGNED_IN' ||
                                        event === 'TOKEN_REFRESHED' ||
                                        event === 'USER_UPDATED'
                                    ) {
                                        if (currentUser) {
                                            syncCachedActiveProfile();
                                        }
                                    }

                                    if (event === 'SIGNED_IN') {
                                        dispatchChange('sign_in');

                                        /*
                                         * Очередь отправляется после
                                         * завершения auth callback.
                                         */
                                        setTimeout(function () {
                                            flushCases();
                                        }, 0);
                                    }

                                    if (event === 'SIGNED_OUT') {
                                        currentUser = null;
                                        storageRemove(
                                            CLOUD_PROFILE_KEY
                                        );
                                        dispatchChange('sign_out');
                                    }
                                } catch (e) {
                                    /* Auth callback никогда не ломает страницу. */
                                }
                            }
                        );

                        /*
                         * Восстанавливаем текущую сессию.
                         */
                        supabaseClient.auth
                            .getSession()
                            .then(function (response) {
                                try {
                                    if (
                                        response &&
                                        response.data &&
                                        response.data.session
                                    ) {
                                        currentUser =
                                            response.data.session.user ||
                                            null;

                                        if (currentUser) {
                                            syncCachedActiveProfile();
                                        }
                                    }

                                    initialized = true;

                                    resolve({
                                        ok: true
                                    });

                                    /*
                                     * Если пользователь уже вошёл,
                                     * пробуем отправить офлайн-очередь.
                                     */
                                    if (currentUser) {
                                        setTimeout(
                                            function () {
                                                flushCases();
                                            },
                                            0
                                        );
                                    }
                                } catch (e2) {
                                    initialized = true;

                                    resolve({
                                        ok: false,
                                        error: 'auth_failed'
                                    });
                                }
                            })
                            .catch(function () {
                                initialized = true;

                                resolve({
                                    ok: false,
                                    error: 'network'
                                });
                            });
                    } catch (e3) {
                        initialized = true;

                        resolve({
                            ok: false,
                            error: 'auth_failed'
                        });
                    }
                })
                .catch(function () {
                    initialized = true;

                    resolve({
                        ok: false,
                        error: 'unknown'
                    });
                });
        });

        return initPromise;
    }

    /*
     * LexAuth.ready всегда разрешается.
     */
    var ready = init().catch(function () {
        return {
            ok: false,
            error: 'unknown'
        };
    });

    /* =========================================================
       Auth
       ========================================================= */

    function available() {
        return !!(
            isHttpsPage() &&
            supabaseClient &&
            typeof supabaseClient.auth === 'object'
        );
    }

    function signIn() {
        return init()
            .then(function (initResult) {
                if (!initResult.ok || !available()) {
                    return {
                        ok: false,
                        error: initResult.error || 'unavailable'
                    };
                }

                try {
                    var redirectTo =
                        window.location.href;

                    return supabaseClient.auth
                        .signInWithOAuth({
                            provider: 'discord',
                            options: {
                                redirectTo: redirectTo,
                                scopes: 'identify email',
                                queryParams: {
                                    scope: 'identify email'
                                }
                            }
                        })
                        .then(function (response) {
                            if (
                                response &&
                                response.error
                            ) {
                                return {
                                    ok: false,
                                    error: 'auth_failed'
                                };
                            }

                            return {
                                ok: true
                            };
                        })
                        .catch(function () {
                            return {
                                ok: false,
                                error: 'auth_failed'
                            };
                        });
                } catch (e) {
                    return {
                        ok: false,
                        error: 'auth_failed'
                    };
                }
            })
            .catch(function () {
                return {
                    ok: false,
                    error: 'auth_failed'
                };
            });
    }

    function clearSupabaseStorage() {
        try {
            if (
                typeof window === 'undefined' ||
                !window.localStorage
            ) {
                return;
            }

            var keys = [];

            for (
                var i = 0;
                i < window.localStorage.length;
                i += 1
            ) {
                var key =
                    window.localStorage.key(i);

                if (
                    key &&
                    (
                        key.indexOf('sb-') === 0 ||
                        key.indexOf('supabase') !== -1
                    )
                ) {
                    keys.push(key);
                }
            }

            for (var j = 0; j < keys.length; j += 1) {
                try {
                    window.localStorage.removeItem(
                        keys[j]
                    );
                } catch (e) {
                    /* ignore */
                }
            }
        } catch (e2) {
            /* ignore */
        }
    }

    function signOut() {
        return init()
            .then(function (initResult) {
                if (
                    !initResult.ok ||
                    !supabaseClient
                ) {
                    currentUser = null;

                    storageRemove(
                        CLOUD_PROFILE_KEY
                    );

                    clearSupabaseStorage();

                    dispatchChange('sign_out');

                    return {
                        ok: true
                    };
                }

                return supabaseClient.auth
                    .signOut()
                    .then(function (response) {
                        if (
                            response &&
                            response.error
                        ) {
                            return {
                                ok: false,
                                error: 'auth_failed'
                            };
                        }

                        currentUser = null;

                        storageRemove(
                            CLOUD_PROFILE_KEY
                        );

                        clearSupabaseStorage();

                        dispatchChange('sign_out');

                        return {
                            ok: true
                        };
                    })
                    .catch(function () {
                        /*
                         * Даже если сеть пропала,
                         * локальный auth cache очищаем.
                         */
                        currentUser = null;

                        storageRemove(
                            CLOUD_PROFILE_KEY
                        );

                        clearSupabaseStorage();

                        dispatchChange('sign_out');

                        return {
                            ok: true
                        };
                    });
            })
            .catch(function () {
                currentUser = null;

                storageRemove(
                    CLOUD_PROFILE_KEY
                );

                clearSupabaseStorage();

                dispatchChange('sign_out');

                return {
                    ok: true
                };
            });
    }

    /* =========================================================
       User / Discord metadata
       ========================================================= */

    function metadataString(metadata, keys) {
        try {
            if (!metadata) {
                return null;
            }

            for (
                var i = 0;
                i < keys.length;
                i += 1
            ) {
                var value = metadata[keys[i]];

                if (
                    typeof value === 'string' &&
                    value.trim()
                ) {
                    return value.trim();
                }
            }
        } catch (e) {
            /* ignore */
        }

        return null;
    }

    function getDiscordUser() {
        try {
            if (!currentUser) {
                return null;
            }

            var metadata =
                currentUser.user_metadata || {};

            /*
             * Supabase OAuth user metadata зависит от
             * данных, которые возвращает OAuth provider.
             *
             * Discord ID обычно доступен как provider_id
             * на user-объекте либо sub в metadata.
             */
            var discordId =
                currentUser.provider_id ||
                metadata.provider_id ||
                metadata.sub ||
                metadata.provider_id_discord ||
                null;

            var discordName =
                metadata.full_name ||
                metadata.name ||
                metadata.preferred_username ||
                metadata.user_name ||
                metadata.username ||
                null;

            if (
                discordId !== null
            ) {
                discordId = String(discordId);
            }

            if (
                discordName !== null
            ) {
                discordName = String(discordName);
            }

            if (!discordId && currentUser.id) {
                /*
                 * Это Supabase UUID, а не Discord ID.
                 * Используем его только как последний fallback
                 * для отображения идентификатора пользователя.
                 */
                discordId = String(currentUser.id);
            }

            return {
                discordId: discordId,
                discordName: discordName
            };
        } catch (e) {
            return null;
        }
    }

    function user() {
        return Promise.resolve(
            getDiscordUser()
        );
    }

    /* =========================================================
       Профили — преобразование
       ========================================================= */

    function localProfileFromRow(row) {
        if (!row) {
            return null;
        }

        return {
            cloudId: row.id || null,
            name: row.name || '',
            id: row.rp_id || '',
            role: row.role || '',
            mail: row.mail || '',
            passport: row.passport || '',
            license: row.license || '',
            isActive: !!row.is_active
        };
    }

    function profileToRow(profile) {
        profile = profile || {};

        return {
            name: normalizeString(
                profile.name,
                80
            ),
            rp_id: normalizeString(
                profile.id,
                20
            ),
            role:
                profile.role === 'adv' ||
                profile.role === 'prok'
                    ? profile.role
                    : null,
            mail: normalizeString(
                profile.mail,
                60
            ),
            passport: normalizePassport(
                profile.passport
            ),
            license: normalizeString(
                profile.license,
                40
            )
        };
    }

    function normalizeString(value, maxLength) {
        if (
            value === null ||
            typeof value === 'undefined'
        ) {
            return '';
        }

        value = String(value);

        if (value.length > maxLength) {
            return value.substring(
                0,
                maxLength
            );
        }

        return value;
    }

    function normalizePassport(value) {
        value = normalizeString(
            value,
            300
        );

        if (
            value === '' ||
            value.indexOf('https://') === 0
        ) {
            return value;
        }

        return '';
    }

    function validateProfile(profile) {
        if (!profile || typeof profile !== 'object') {
            return {
                ok: false,
                error: 'invalid_data'
            };
        }

        if (
            profile.name &&
            String(profile.name).length > 80
        ) {
            return {
                ok: false,
                error: 'invalid_data'
            };
        }

        if (
            profile.id &&
            String(profile.id).length > 20
        ) {
            return {
                ok: false,
                error: 'invalid_data'
            };
        }

        if (
            profile.mail &&
            String(profile.mail).length > 60
        ) {
            return {
                ok: false,
                error: 'invalid_data'
            };
        }

        if (
            profile.passport &&
            String(profile.passport).length > 300
        ) {
            return {
                ok: false,
                error: 'invalid_data'
            };
        }

        if (
            profile.passport &&
            String(profile.passport).indexOf(
                'https://'
            ) !== 0
        ) {
            return {
                ok: false,
                error: 'invalid_data'
            };
        }

        if (
            profile.license &&
            String(profile.license).length > 40
        ) {
            return {
                ok: false,
                error: 'invalid_data'
            };
        }

        if (
            profile.role !== undefined &&
            profile.role !== null &&
            profile.role !== '' &&
            profile.role !== 'adv' &&
            profile.role !== 'prok'
        ) {
            return {
                ok: false,
                error: 'invalid_data'
            };
        }

        return {
            ok: true
        };
    }

    /* =========================================================
       Profiles API
       ========================================================= */

    function profilesList() {
        return init()
            .then(function (r) {
                if (!r.ok || !supabaseClient) {
                    return {
                        ok: false,
                        error: r.error || 'unavailable'
                    };
                }

                if (!currentUser) {
                    return {
                        ok: false,
                        error: 'not_authenticated'
                    };
                }

                return supabaseClient
                    .from('profiles')
                    .select(
                        'id,name,rp_id,role,mail,passport,license,is_active,created_at,updated_at'
                    )
                    .eq(
                        'user_id',
                        currentUser.id
                    )
                    .order(
                        'created_at',
                        {
                            ascending: true
                        }
                    )
                    .then(function (response) {
                        if (response.error) {
                            return {
                                ok: false,
                                error:
                                    safeErrorCode(
                                        response.error,
                                        'cloud_error'
                                    )
                            };
                        }

                        var rows =
                            response.data || [];

                        var profiles =
                            rows.map(
                                localProfileFromRow
                            );

                        /*
                         * Обновляем кеш активного профиля.
                         */
                        var active = null;

                        for (
                            var i = 0;
                            i < profiles.length;
                            i += 1
                        ) {
                            if (
                                profiles[i].isActive
                            ) {
                                active =
                                    profiles[i];
                                break;
                            }
                        }

                        if (active) {
                            saveCloudProfileCache(
                                active
                            );
                        }

                        return {
                            ok: true,
                            data: profiles
                        };
                    })
                    .catch(function () {
                        return {
                            ok: false,
                            error: 'network'
                        };
                    });
            })
            .catch(function () {
                return {
                    ok: false,
                    error: 'unknown'
                };
            });
    }

    function profilesCreate(profile) {
        var validation =
            validateProfile(profile);

        if (!validation.ok) {
            return Promise.resolve(
                validation
            );
        }

        return init()
            .then(function (r) {
                if (!r.ok || !supabaseClient) {
                    return {
                        ok: false,
                        error: r.error || 'unavailable'
                    };
                }

                if (!currentUser) {
                    return {
                        ok: false,
                        error: 'not_authenticated'
                    };
                }

                var row =
                    profileToRow(profile);

                /*
                 * user_id намеренно задаётся клиентом как
                 * текущий user.id. RLS проверяет совпадение.
                 */
                row.user_id =
                    currentUser.id;

                return supabaseClient
                    .from('profiles')
                    .insert(row)
                    .select(
                        'id,name,rp_id,role,mail,passport,license,is_active,created_at,updated_at'
                    )
                    .single()
                    .then(function (response) {
                        if (response.error) {
                            return {
                                ok: false,
                                error:
                                    safeErrorCode(
                                        response.error,
                                        'cloud_error'
                                    )
                            };
                        }

                        var result =
                            localProfileFromRow(
                                response.data
                            );

                        if (
                            result &&
                            result.isActive
                        ) {
                            saveCloudProfileCache(
                                result
                            );
                        }

                        dispatchChange(
                            'profile_create'
                        );

                        return {
                            ok: true,
                            data: result
                        };
                    })
                    .catch(function () {
                        return {
                            ok: false,
                            error: 'network'
                        };
                    });
            })
            .catch(function () {
                return {
                    ok: false,
                    error: 'unknown'
                };
            });
    }

    function profilesUpdate(
        cloudId,
        profile
    ) {
        var validation =
            validateProfile(profile);

        if (!validation.ok) {
            return Promise.resolve(
                validation
            );
        }

        if (!cloudId) {
            return Promise.resolve({
                ok: false,
                error: 'profile_not_found'
            });
        }

        return init()
            .then(function (r) {
                if (!r.ok || !supabaseClient) {
                    return {
                        ok: false,
                        error: r.error || 'unavailable'
                    };
                }

                if (!currentUser) {
                    return {
                        ok: false,
                        error: 'not_authenticated'
                    };
                }

                var row =
                    profileToRow(profile);

                return supabaseClient
                    .from('profiles')
                    .update(row)
                    .eq('id', cloudId)
                    .eq(
                        'user_id',
                        currentUser.id
                    )
                    .select(
                        'id,name,rp_id,role,mail,passport,license,is_active,created_at,updated_at'
                    )
                    .maybeSingle()
                    .then(function (response) {
                        if (response.error) {
                            return {
                                ok: false,
                                error:
                                    safeErrorCode(
                                        response.error,
                                        'cloud_error'
                                    )
                            };
                        }

                        if (!response.data) {
                            return {
                                ok: false,
                                error: 'profile_not_found'
                            };
                        }

                        var result =
                            localProfileFromRow(
                                response.data
                            );

                        if (
                            result &&
                            result.isActive
                        ) {
                            saveCloudProfileCache(
                                result
                            );
                        }

                        dispatchChange(
                            'profile_update'
                        );

                        return {
                            ok: true,
                            data: result
                        };
                    })
                    .catch(function () {
                        return {
                            ok: false,
                            error: 'network'
                        };
                    });
            })
            .catch(function () {
                return {
                    ok: false,
                    error: 'unknown'
                };
            });
    }

    function profilesRemove(cloudId) {
        if (!cloudId) {
            return Promise.resolve({
                ok: false,
                error: 'profile_not_found'
            });
        }

        return init()
            .then(function (r) {
                if (!r.ok || !supabaseClient) {
                    return {
                        ok: false,
                        error: r.error || 'unavailable'
                    };
                }

                if (!currentUser) {
                    return {
                        ok: false,
                        error: 'not_authenticated'
                    };
                }

                return supabaseClient
                    .from('profiles')
                    .delete()
                    .eq('id', cloudId)
                    .eq(
                        'user_id',
                        currentUser.id
                    )
                    .select('id')
                    .maybeSingle()
                    .then(function (response) {
                        if (response.error) {
                            return {
                                ok: false,
                                error:
                                    safeErrorCode(
                                        response.error,
                                        'cloud_error'
                                    )
                            };
                        }

                        if (!response.data) {
                            return {
                                ok: false,
                                error: 'profile_not_found'
                            };
                        }

                        var cached =
                            getCloudProfileCache();

                        if (
                            cached &&
                            cached.profile &&
                            cached.profile.cloudId ===
                                cloudId
                        ) {
                            storageRemove(
                                CLOUD_PROFILE_KEY
                            );
                        }

                        dispatchChange(
                            'profile_remove'
                        );

                        return {
                            ok: true
                        };
                    })
                    .catch(function () {
                        return {
                            ok: false,
                            error: 'network'
                        };
                    });
            })
            .catch(function () {
                return {
                    ok: false,
                    error: 'unknown'
                };
            });
    }

    function profilesSetActive(cloudId) {
        if (!cloudId) {
            return Promise.resolve({
                ok: false,
                error: 'profile_not_found'
            });
        }

        return init()
            .then(function (r) {
                if (!r.ok || !supabaseClient) {
                    return {
                        ok: false,
                        error: r.error || 'unavailable'
                    };
                }

                if (!currentUser) {
                    return {
                        ok: false,
                        error: 'not_authenticated'
                    };
                }

                return supabaseClient
                    .rpc(
                        'set_active_profile',
                        {
                            p_id: cloudId
                        }
                    )
                    .then(function (response) {
                        if (response.error) {
                            return {
                                ok: false,
                                error:
                                    safeErrorCode(
                                        response.error,
                                        'profile_not_found'
                                    )
                            };
                        }

                        /*
                         * Получаем обновлённый активный профиль.
                         */
                        return supabaseClient
                            .from('profiles')
                            .select(
                                'id,name,rp_id,role,mail,passport,license,is_active,created_at,updated_at'
                            )
                            .eq(
                                'id',
                                cloudId
                            )
                            .eq(
                                'user_id',
                                currentUser.id
                            )
                            .maybeSingle()
                            .then(function (
                                profileResponse
                            ) {
                                if (
                                    profileResponse.error
                                ) {
                                    return {
                                        ok: false,
                                        error:
                                            'cloud_error'
                                    };
                                }

                                if (
                                    !profileResponse.data
                                ) {
                                    return {
                                        ok: false,
                                        error:
                                            'profile_not_found'
                                    };
                                }

                                var result =
                                    localProfileFromRow(
                                        profileResponse.data
                                    );

                                saveCloudProfileCache(
                                    result
                                );

                                dispatchChange(
                                    'profile_active'
                                );

                                return {
                                    ok: true,
                                    data: result
                                };
                            })
                            .catch(function () {
                                return {
                                    ok: false,
                                    error: 'network'
                                };
                            });
                    })
                    .catch(function () {
                        return {
                            ok: false,
                            error: 'network'
                        };
                    });
            })
            .catch(function () {
                return {
                    ok: false,
                    error: 'unknown'
                };
            });
    }

    function profilesActive() {
        /*
         * Сначала пробуем кеш.
         * Если облако доступно — затем обновляем его.
         */
        var cached =
            getCloudProfileCache();

        if (
            cached &&
            cached.profile
        ) {
            /*
             * Возвращаем кеш сразу как Promise.
             * Актуализация выполняется отдельно.
             */
            refreshActiveProfileInBackground();
            return Promise.resolve({
                ok: true,
                data: cached.profile,
                cached: true
            });
        }

        return profilesList()
            .then(function (response) {
                if (!response.ok) {
                    return response;
                }

                for (
                    var i = 0;
                    i < response.data.length;
                    i += 1
                ) {
                    if (
                        response.data[i].isActive
                    ) {
                        return {
                            ok: true,
                            data:
                                response.data[i]
                        };
                    }
                }

                return {
                    ok: true,
                    data: null
                };
            });
    }

    function saveCloudProfileCache(
        profile
    ) {
        try {
            if (!currentUser || !profile) {
                return;
            }

            storageSet(
                CLOUD_PROFILE_KEY,
                JSON.stringify({
                    userId:
                        currentUser.id,
                    profile: profile,
                    ts: Date.now()
                })
            );
        } catch (e) {
            /* ignore */
        }
    }

    function getCloudProfileCache() {
        var cached =
            parseStored(
                CLOUD_PROFILE_KEY,
                null
            );

        if (
            !cached ||
            !cached.profile
        ) {
            return null;
        }

        /*
         * Если currentUser уже известен, кеш другого
         * пользователя никогда не отдаём.
         */
        if (
            currentUser &&
            cached.userId !== currentUser.id
        ) {
            storageRemove(
                CLOUD_PROFILE_KEY
            );
            return null;
        }

        return cached;
    }

    function syncCachedActiveProfile() {
        try {
            var cached =
                getCloudProfileCache();

            if (
                cached &&
                currentUser &&
                cached.userId === currentUser.id
            ) {
                return;
            }

            /*
             * Не ждём сеть в auth callback.
             */
            profilesList().catch(function () {
                /* ignore */
            });
        } catch (e) {
            /* ignore */
        }
    }

    function refreshActiveProfileInBackground() {
        try {
            profilesList().catch(function () {
                /* ignore */
            });
        } catch (e) {
            /* ignore */
        }
    }

    /* =========================================================
       Cases helpers
       ========================================================= */

    function normalizeCase(c) {
        c = c || {};

        return {
            localId:
                c.localId === null ||
                typeof c.localId === 'undefined'
                    ? ''
                    : String(c.localId),

            outcome:
                c.outcome === null ||
                typeof c.outcome === 'undefined'
                    ? ''
                    : String(c.outcome),

            closedAt:
                c.closedAt === null ||
                typeof c.closedAt === 'undefined'
                    ? null
                    : String(c.closedAt),

            withTexts:
                !!c.withTexts,

            data:
                c.data &&
                typeof c.data === 'object'
                    ? c.data
                    : {},

            appVersion:
                c.appVersion === null ||
                typeof c.appVersion === 'undefined'
                    ? ''
                    : String(c.appVersion),

            dbVersion:
                c.dbVersion === null ||
                typeof c.dbVersion === 'undefined'
                    ? ''
                    : String(c.dbVersion),

            profileId:
                c.profileId || null
        };
    }

    function validateCase(c) {
        if (!c || typeof c !== 'object') {
            return {
                ok: false,
                error: 'invalid_data'
            };
        }

        if (
            !c.localId ||
            String(c.localId).length === 0
        ) {
            return {
                ok: false,
                error: 'invalid_data'
            };
        }

        if (
            String(c.localId).length > 300
        ) {
            return {
                ok: false,
                error: 'invalid_data'
            };
        }

        if (
            c.outcome &&
            String(c.outcome).length > 40
        ) {
            return {
                ok: false,
                error: 'invalid_data'
            };
        }

        var bytes =
            utf8ByteLength(
                c.data || {}
            );

        if (
            bytes < 0
        ) {
            return {
                ok: false,
                error: 'invalid_data'
            };
        }

        if (
            bytes > MAX_CASE_DATA_BYTES
        ) {
            return {
                ok: false,
                error: 'data_too_large'
            };
        }

        return {
            ok: true,
            bytes: bytes
        };
    }

    function caseRowFromInput(c) {
        var normalized =
            normalizeCase(c);

        var row = {
            local_id:
                normalized.localId,

            outcome:
                normalized.outcome,

            closed_at:
                normalized.closedAt,

            with_texts:
                normalized.withTexts,

            data:
                normalized.data,

            app_version:
                normalized.appVersion,

            db_version:
                normalized.dbVersion
        };

        if (
            normalized.profileId
        ) {
            row.profile_id =
                normalized.profileId;
        }

        return row;
    }

    function caseListItem(row) {
        return {
            id:
                row.id || null,

            localId:
                row.local_id || '',

            createdAt:
                row.created_at || null,

            closedAt:
                row.closed_at || null,

            outcome:
                row.outcome || '',

            withTexts:
                !!row.with_texts
        };
    }

    function caseFull(row) {
        return {
            id:
                row.id || null,

            localId:
                row.local_id || '',

            createdAt:
                row.created_at || null,

            closedAt:
                row.closed_at || null,

            outcome:
                row.outcome || '',

            withTexts:
                !!row.with_texts,

            data:
                row.data || {},

            appVersion:
                row.app_version || '',

            dbVersion:
                row.db_version || '',

            profileId:
                row.profile_id || null
        };
    }

    /* =========================================================
       Cases — local queue
       ========================================================= */

    function getQueue() {
        var queue =
            parseStored(
                CASE_QUEUE_KEY,
                []
            );

        if (!Array.isArray(queue)) {
            return [];
        }

        return queue;
    }

    function setQueue(queue) {
        if (!Array.isArray(queue)) {
            queue = [];
        }

        storageSet(
            CASE_QUEUE_KEY,
            JSON.stringify(queue)
        );
    }

    function enqueueCase(c) {
        var queue =
            getQueue();

        queue.push({
            queuedAt: Date.now(),
            caseData: c
        });

        while (
            queue.length >
            MAX_QUEUE
        ) {
            queue.shift();

            try {
                console.warn(
                    '[LexAuth] queue_full'
                );
            } catch (e) {
                /* ignore */
            }
        }

        setQueue(queue);

        return {
            ok: false,
            error: 'network',
            queued: true,
            queueSize: queue.length
        };
    }

    /* =========================================================
       Cases — cloud
       ========================================================= */

    function saveCase(c) {
        var normalized =
            normalizeCase(c);

        var validation =
            validateCase(normalized);

        if (!validation.ok) {
            return Promise.resolve(
                validation
            );
        }

        /*
         * Если облако недоступно или пользователь не вошёл,
         * сохраняем в локальную очередь.
         */
        return init()
            .then(function (r) {
                if (
                    !r.ok ||
                    !supabaseClient ||
                    !currentUser
                ) {
                    return enqueueCase(
                        normalized
                    );
                }

                var row =
                    caseRowFromInput(
                        normalized
                    );

                row.user_id =
                    currentUser.id;

                return supabaseClient
                    .from('cases')
                    .upsert(
                        row,
                        {
                            onConflict:
                                'user_id,local_id'
                        }
                    )
                    .select(
                        'id,local_id,created_at,closed_at,outcome,with_texts,data,app_version,db_version,profile_id'
                    )
                    .single()
                    .then(function (response) {
                        if (
                            response.error
                        ) {
                            var code =
                                safeErrorCode(
                                    response.error,
                                    'cloud_error'
                                );

                            if (
                                code ===
                                'cases_quota'
                            ) {
                                return {
                                    ok: false,
                                    error:
                                        'cases_quota'
                                };
                            }

                            /*
                             * Сетевая ошибка → очередь.
                             */
                            if (
                                code === 'network'
                            ) {
                                return enqueueCase(
                                    normalized
                                );
                            }

                            return {
                                ok: false,
                                error: code
                            };
                        }

                        return {
                            ok: true,
                            data:
                                caseFull(
                                    response.data
                                )
                        };
                    })
                    .catch(function () {
                        return enqueueCase(
                            normalized
                        );
                    });
            })
            .catch(function () {
                return enqueueCase(
                    normalized
                );
            });
    }

    function listCases(options) {
        options =
            options || {};

        var limit =
            parseInt(
                options.limit,
                10
            );

        if (
            !isFinite(limit) ||
            limit < 1
        ) {
            limit = 50;
        }

        if (limit > 100) {
            limit = 100;
        }

        return init()
            .then(function (r) {
                if (!r.ok || !supabaseClient) {
                    return {
                        ok: false,
                        error:
                            r.error ||
                            'unavailable'
                    };
                }

                if (!currentUser) {
                    return {
                        ok: false,
                        error:
                            'not_authenticated'
                    };
                }

                var query =
                    supabaseClient
                        .from('cases')
                        .select(
                            'id,local_id,created_at,closed_at,outcome,with_texts'
                        )
                        .eq(
                            'user_id',
                            currentUser.id
                        )
                        .order(
                            'created_at',
                            {
                                ascending: false
                            }
                        )
                        .limit(limit);

                if (
                    options.before
                ) {
                    query =
                        query.lt(
                            'created_at',
                            String(
                                options.before
                            )
                        );
                }

                return query
                    .then(function (response) {
                        if (
                            response.error
                        ) {
                            return {
                                ok: false,
                                error:
                                    safeErrorCode(
                                        response.error,
                                        'cloud_error'
                                    )
                            };
                        }

                        return {
                            ok: true,
                            data:
                                (
                                    response.data ||
                                    []
                                ).map(
                                    caseListItem
                                )
                        };
                    })
                    .catch(function () {
                        return {
                            ok: false,
                            error: 'network'
                        };
                    });
            })
            .catch(function () {
                return {
                    ok: false,
                    error: 'unknown'
                };
            });
    }

    function getCase(id) {
        if (!id) {
            return Promise.resolve({
                ok: false,
                error: 'case_not_found'
            });
        }

        return init()
            .then(function (r) {
                if (!r.ok || !supabaseClient) {
                    return {
                        ok: false,
                        error:
                            r.error ||
                            'unavailable'
                    };
                }

                if (!currentUser) {
                    return {
                        ok: false,
                        error:
                            'not_authenticated'
                    };
                }

                return supabaseClient
                    .from('cases')
                    .select(
                        'id,local_id,created_at,closed_at,outcome,with_texts,data,app_version,db_version,profile_id'
                    )
                    .eq(
                        'id',
                        id
                    )
                    .eq(
                        'user_id',
                        currentUser.id
                    )
                    .maybeSingle()
                    .then(function (response) {
                        if (
                            response.error
                        ) {
                            return {
                                ok: false,
                                error:
                                    safeErrorCode(
                                        response.error,
                                        'cloud_error'
                                    )
                            };
                        }

                        if (
                            !response.data
                        ) {
                            return {
                                ok: false,
                                error:
                                    'case_not_found'
                            };
                        }

                        return {
                            ok: true,
                            data:
                                caseFull(
                                    response.data
                                )
                        };
                    })
                    .catch(function () {
                        return {
                            ok: false,
                            error: 'network'
                        };
                    });
            })
            .catch(function () {
                return {
                    ok: false,
                    error: 'unknown'
                };
            });
    }

    function removeCase(id) {
        if (!id) {
            return Promise.resolve({
                ok: false,
                error: 'case_not_found'
            });
        }

        return init()
            .then(function (r) {
                if (!r.ok || !supabaseClient) {
                    return {
                        ok: false,
                        error:
                            r.error ||
                            'unavailable'
                    };
                }

                if (!currentUser) {
                    return {
                        ok: false,
                        error:
                            'not_authenticated'
                    };
                }

                return supabaseClient
                    .from('cases')
                    .delete()
                    .eq(
                        'id',
                        id
                    )
                    .eq(
                        'user_id',
                        currentUser.id
                    )
                    .select('id')
                    .maybeSingle()
                    .then(function (response) {
                        if (
                            response.error
                        ) {
                            return {
                                ok: false,
                                error:
                                    safeErrorCode(
                                        response.error,
                                        'cloud_error'
                                    )
                            };
                        }

                        if (
                            !response.data
                        ) {
                            return {
                                ok: false,
                                error:
                                    'case_not_found'
                            };
                        }

                        return {
                            ok: true
                        };
                    })
                    .catch(function () {
                        return {
                            ok: false,
                            error: 'network'
                        };
                    });
            })
            .catch(function () {
                return {
                    ok: false,
                    error: 'unknown'
                };
            });
    }

    function countCases() {
        return init()
            .then(function (r) {
                if (!r.ok || !supabaseClient) {
                    return {
                        ok: false,
                        error:
                            r.error ||
                            'unavailable'
                    };
                }

                if (!currentUser) {
                    return {
                        ok: false,
                        error:
                            'not_authenticated'
                    };
                }

                return supabaseClient
                    .from('cases')
                    .select(
                        'id',
                        {
                            count: 'exact',
                            head: true
                        }
                    )
                    .eq(
                        'user_id',
                        currentUser.id
                    )
                    .then(function (response) {
                        if (
                            response.error
                        ) {
                            return {
                                ok: false,
                                error:
                                    safeErrorCode(
                                        response.error,
                                        'cloud_error'
                                    )
                            };
                        }

                        return {
                            ok: true,
                            data:
                                Number(
                                    response.count ||
                                    0
                                )
                        };
                    })
                    .catch(function () {
                        return {
                            ok: false,
                            error: 'network'
                        };
                    });
            })
            .catch(function () {
                return {
                    ok: false,
                    error: 'unknown'
                };
            });
    }

    /* =========================================================
       Flush очереди
       ========================================================= */

    var flushRunning = false;

    function flushCases() {
        if (flushRunning) {
            return Promise.resolve({
                ok: true,
                sent: 0,
                remaining:
                    getQueue().length
            });
        }

        var queue =
            getQueue();

        if (!queue.length) {
            return Promise.resolve({
                ok: true,
                sent: 0,
                remaining: 0
            });
        }

        return init()
            .then(function (r) {
                if (
                    !r.ok ||
                    !supabaseClient ||
                    !currentUser
                ) {
                    return {
                        ok: false,
                        error:
                            r.error ||
                            'not_authenticated',
                        sent: 0,
                        remaining:
                            queue.length
                    };
                }

                flushRunning = true;

                var sent = 0;

                function next(index) {
                    if (
                        index >= queue.length
                    ) {
                        flushRunning = false;

                        var remaining =
                            getQueue().length;

                        if (
                            sent > 0
                        ) {
                            dispatchChange(
                                'cases_flush'
                            );
                        }

                        return {
                            ok: true,
                            sent: sent,
                            remaining:
                                remaining
                        };
                    }

                    var item =
                        queue[index];

                    if (
                        !item ||
                        !item.caseData
                    ) {
                        queue.splice(
                            index,
                            1
                        );

                        setQueue(queue);

                        return next(index);
                    }

                    return saveCaseDirect(
                        item.caseData
                    ).then(function (
                        response
                    ) {
                        if (
                            response.ok
                        ) {
                            /*
                             * Удаляем именно этот элемент.
                             */
                            queue.splice(
                                index,
                                1
                            );

                            setQueue(
                                queue
                            );

                            sent += 1;

                            return next(
                                index
                            );
                        }

                        /*
                         * Если сервер отказал по данным,
                         * оставлять такой элемент в очереди
                         * бессмысленно.
                         */
                        if (
                            response.error ===
                                'invalid_data' ||
                            response.error ===
                                'data_too_large' ||
                            response.error ===
                                'cases_quota'
                        ) {
                            queue.splice(
                                index,
                                1
                            );

                            setQueue(
                                queue
                            );

                            return next(
                                index
                            );
                        }

                        /*
                         * Сеть/временная ошибка:
                         * оставляем очередь и останавливаем flush.
                         */
                        flushRunning = false;

                        return {
                            ok: false,
                            error:
                                response.error ||
                                'network',
                            sent: sent,
                            remaining:
                                queue.length
                        };
                    });
                }

                return next(0);
            })
            .catch(function () {
                flushRunning = false;

                return {
                    ok: false,
                    error: 'network',
                    sent: 0,
                    remaining:
                        getQueue().length
                };
            });
    }

    function saveCaseDirect(c) {
        var normalized =
            normalizeCase(c);

        var validation =
            validateCase(
                normalized
            );

        if (!validation.ok) {
            return Promise.resolve(
                validation
            );
        }

        if (
            !supabaseClient ||
            !currentUser
        ) {
            return Promise.resolve({
                ok: false,
                error:
                    'not_authenticated'
            });
        }

        var row =
            caseRowFromInput(
                normalized
            );

        row.user_id =
            currentUser.id;

        return supabaseClient
            .from('cases')
            .upsert(
                row,
                {
                    onConflict:
                        'user_id,local_id'
                }
            )
            .select(
                'id,local_id,created_at,closed_at,outcome,with_texts,data,app_version,db_version,profile_id'
            )
            .single()
            .then(function (response) {
                if (
                    response.error
                ) {
                    return {
                        ok: false,
                        error:
                            safeErrorCode(
                                response.error,
                                'cloud_error'
                            )
                    };
                }

                return {
                    ok: true,
                    data:
                        caseFull(
                            response.data
                        )
                };
            })
            .catch(function () {
                return {
                    ok: false,
                    error: 'network'
                };
            });
    }

    /* =========================================================
       Wipe
       ========================================================= */

    function wipe() {
        return init()
            .then(function (r) {
                if (!r.ok || !supabaseClient) {
                    return {
                        ok: false,
                        error:
                            r.error ||
                            'unavailable'
                    };
                }

                if (!currentUser) {
                    return {
                        ok: false,
                        error:
                            'not_authenticated'
                    };
                }

                var userId =
                    currentUser.id;

                /*
                 * Сначала дела.
                 */
                return supabaseClient
                    .from('cases')
                    .delete()
                    .eq(
                        'user_id',
                        userId
                    )
                    .then(function (
                        casesResponse
                    ) {
                        if (
                            casesResponse.error
                        ) {
                            return {
                                ok: false,
                                error:
                                    safeErrorCode(
                                        casesResponse.error,
                                        'cloud_error'
                                    )
                            };
                        }

                        return supabaseClient
                            .from('profiles')
                            .delete()
                            .eq(
                                'user_id',
                                userId
                            )
                            .then(function (
                                profilesResponse
                            ) {
                                if (
                                    profilesResponse.error
                                ) {
                                    return {
                                        ok: false,
                                        error:
                                            safeErrorCode(
                                                profilesResponse.error,
                                                'cloud_error'
                                            )
                                    };
                                }

                                storageRemove(
                                    PROFILE_KEY
                                );

                                storageRemove(
                                    CLOUD_PROFILE_KEY
                                );

                                storageRemove(
                                    CASE_QUEUE_KEY
                                );

                                dispatchChange(
                                    'wipe'
                                );

                                return {
                                    ok: true
                                };
                            })
                            .catch(function () {
                                return {
                                    ok: false,
                                    error: 'network'
                                };
                            });
                    })
                    .catch(function () {
                        return {
                            ok: false,
                            error: 'network'
                        };
                    });
            })
            .catch(function () {
                return {
                    ok: false,
                    error: 'unknown'
                };
            });
    }

    /* =========================================================
       online
       ========================================================= */

    try {
        if (
            typeof window !== 'undefined' &&
            typeof window.addEventListener ===
                'function'
        ) {
            window.addEventListener(
                'online',
                function () {
                    try {
                        flushCases();
                    } catch (e) {
                        /* ignore */
                    }
                }
            );
        }
    } catch (e) {
        /* ignore */
    }

    /* =========================================================
       Публичный объект
       ========================================================= */

    exported.available = available;
    exported.ready = ready;
    exported.init = init;
    exported.signIn = signIn;
    exported.signOut = signOut;
    exported.user = user;

    exported.profiles = {
        list: profilesList,
        create: profilesCreate,
        update: profilesUpdate,
        remove: profilesRemove,
        setActive: profilesSetActive,
        active: profilesActive
    };

    exported.cases = {
        save: saveCase,
        list: listCases,
        get: getCase,
        remove: removeCase,
        count: countCases,
        flush: flushCases
    };

    exported.wipe = wipe;

    /*
     * Ссылка на локальный профиль оставлена для совместимости
     * с существующей карточкой Lex.
     *
     * Эти функции не используют Supabase и поэтому работают
     * также в file://.
     */
    exported.localProfile = function () {
        try {
            if (
                typeof window !== 'undefined' &&
                typeof window.lexProfile ===
                    'function'
            ) {
                return window.lexProfile();
            }
        } catch (e) {
            /* ignore */
        }

        return null;
    };

    exported.localProfileSave =
        function (profile) {
            try {
                if (
                    typeof window !==
                        'undefined' &&
                    typeof window.lexProfileSave ===
                        'function'
                ) {
                    return window.lexProfileSave(
                        profile
                    );
                }
            } catch (e) {
                /* ignore */
            }

            return false;
        };

    window.LexAuth = exported;
})();
