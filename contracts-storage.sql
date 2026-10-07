-- Lex · хранилище договоров (PDF) в Supabase Storage.
-- Выполнить в SQL Editor по блокам сверху вниз (на телефоне — по одному блоку).

-- 1. Публичный бакет: читать по ссылке может любой, только PDF, до 5 МБ.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('contracts', 'contracts', true, 5242880, array['application/pdf'])
on conflict (id) do update
set public = true, file_size_limit = 5242880, allowed_mime_types = array['application/pdf'];

-- 2. Загружать — только вошедший пользователь и только в свою папку (<user id>/...).
create policy "contracts_insert_own"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'contracts'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

-- 3. Удалять — только свои файлы.
create policy "contracts_delete_own"
on storage.objects for delete to authenticated
using (
  bucket_id = 'contracts'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

-- Проверка: должен вернуться бакет contracts с public = true.
select id, public, file_size_limit, allowed_mime_types from storage.buckets where id = 'contracts';
