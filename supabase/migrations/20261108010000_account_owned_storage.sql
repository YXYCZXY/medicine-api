-- Apply to the Supabase project only when Storage buckets exist.
-- Reads ownership metadata; object deletion MUST still use the Storage API.
CREATE OR REPLACE FUNCTION public.account_deletion_owned_objects(p_user_id uuid)
RETURNS TABLE(bucket_id text, name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT o.bucket_id, o.name FROM storage.objects AS o
  WHERE o.owner_id = p_user_id::text
  ORDER BY o.bucket_id, o.name LIMIT 100;
$$;
REVOKE ALL ON FUNCTION public.account_deletion_owned_objects(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.account_deletion_owned_objects(uuid) TO service_role;
