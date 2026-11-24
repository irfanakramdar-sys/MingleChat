import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

function respond(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return respond({ error: "Only POST is supported." }, 405);

  const projectUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!projectUrl || !anonKey || !serviceRoleKey) {
    console.error("Supabase function secrets are missing.");
    return respond({ error: "Password reset is not configured on the server." }, 503);
  }

  const authorization = request.headers.get("Authorization");
  if (!authorization) return respond({ error: "A signed-in owner account is required." }, 401);

  const callerClient = createClient(projectUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false }
  });
  const { data: userData, error: authError } = await callerClient.auth.getUser();
  if (authError || !userData.user) return respond({ error: "The sign-in session is invalid." }, 401);
  if (userData.user.app_metadata?.role !== "owner") {
    return respond({ error: "Only the Mingle owner can reset account passwords." }, 403);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return respond({ error: "The password reset request must be valid JSON." }, 400);
  }
  if (!body || typeof body !== "object") {
    return respond({ error: "The password reset request is invalid." }, 400);
  }

  const { userId, password } = body as { userId?: unknown; password?: unknown };
  if (typeof userId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) {
    return respond({ error: "Choose a valid account." }, 400);
  }
  if (typeof password !== "string" || password.length < 8 || password.length > 72) {
    return respond({ error: "Choose a password between 8 and 72 characters." }, 400);
  }
  if (userId === userData.user.id) {
    return respond({ error: "You cannot reset your own password from Owner tools." }, 400);
  }

  const adminClient = createClient(projectUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const { data: targetData, error: targetError } = await adminClient.auth.admin.getUserById(userId);
  if (targetError) {
    console.error("Could not verify the selected account:", targetError.message);
    return respond({ error: `Could not verify the selected account: ${targetError.message}` }, 500);
  }
  if (!targetData.user) {
    return respond({ error: "That account could not be found." }, 404);
  }
  if (targetData.user.app_metadata?.role === "owner") {
    return respond({ error: "Another owner account cannot be reset here." }, 403);
  }

  const { error: updateError } = await adminClient.auth.admin.updateUserById(userId, { password });
  if (updateError) {
    console.error("Supabase rejected an owner-requested password reset:", updateError.message);
    return respond({ error: `Could not set the new password: ${updateError.message}` }, 400);
  }

  return respond({ success: true });
});
