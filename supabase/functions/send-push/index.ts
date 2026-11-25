import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import webPush from "npm:web-push@3.6.7";

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
  const vapidPublicKey = Deno.env.get("VAPID_PUBLIC_KEY");
  const vapidPrivateKey = Deno.env.get("VAPID_PRIVATE_KEY");
  const vapidSubject = Deno.env.get("VAPID_SUBJECT");
  if (!projectUrl || !anonKey || !serviceRoleKey) {
    return respond({ error: "Supabase function secrets are missing." }, 503);
  }

  const authorization = request.headers.get("Authorization");
  if (!authorization) return respond({ error: "A signed-in Mingle account is required." }, 401);
  const callerClient = createClient(projectUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false }
  });
  const { data: userData, error: authError } = await callerClient.auth.getUser();
  if (authError || !userData.user) return respond({ error: "The sign-in session is invalid." }, 401);

  let event: { kind?: string; messageId?: string; callId?: string };
  try {
    event = await request.json();
  } catch {
    return respond({ error: "The push request body must be valid JSON." }, 400);
  }

  const admin = createClient(projectUrl, serviceRoleKey, { auth: { persistSession: false } });
  const senderId = userData.user.id;
  const recipients = new Set<string>();
  let payload: Record<string, unknown>;

  if (event.kind === "test") {
    recipients.add(senderId);
    payload = {
      kind: "test",
      title: "Mingle Chat",
      body: "Your background notifications are working.",
      tag: `mingle-test-${senderId}`
    };
  } else if (event.kind === "incoming-call" && event.callId) {
    const { data: call, error } = await admin.from("call_sessions")
      .select("id,caller_id,callee_id,media_type,created_at")
      .eq("id", event.callId)
      .eq("caller_id", senderId)
      .maybeSingle();
    if (error) return respond({ error: `Could not validate the call: ${error.message}` }, 500);
    if (!call || Date.now() - new Date(call.created_at).getTime() > 90000) {
      return respond({ error: "The call is missing or has expired." }, 404);
    }
    recipients.add(call.callee_id);
    const { data: caller, error: profileError } = await admin.from("profiles")
      .select("name")
      .eq("id", senderId)
      .single();
    if (profileError) return respond({ error: `Could not load the caller profile: ${profileError.message}` }, 500);
    payload = {
      kind: "incoming-call",
      callId: call.id,
      title: `${caller.name} is calling`,
      body: call.media_type === "video" ? "Incoming video call" : "Incoming voice call",
      tag: `mingle-call-${call.id}`
    };
  } else if (event.kind === "message" && event.messageId) {
    const { data: message, error } = await admin.from("messages")
      .select("id,sender_id,recipient_id,text,attachment_mime")
      .eq("id", event.messageId)
      .eq("sender_id", senderId)
      .maybeSingle();
    if (error) return respond({ error: `Could not validate the message: ${error.message}` }, 500);
    if (!message) return respond({ error: "The message is missing or does not belong to you." }, 404);
    recipients.add(message.recipient_id);
    const { data: sender, error: profileError } = await admin.from("profiles")
      .select("name,phone")
      .eq("id", senderId)
      .single();
    if (profileError) return respond({ error: `Could not load the sender profile: ${profileError.message}` }, 500);
    const body = message.attachment_mime?.startsWith("image/")
      ? "Photo"
      : message.attachment_mime?.startsWith("video/")
        ? "Video"
        : message.attachment_mime?.startsWith("audio/")
          ? "Voice message"
          : message.text || "New message";
    payload = {
      kind: "message",
      title: sender.name,
      body,
      chat: sender.phone,
      tag: `mingle-${sender.phone}`
    };
  } else if (event.kind === "group-message" && event.messageId) {
    const { data: message, error } = await admin.from("group_messages")
      .select("id,group_id,sender_id,text,attachment_mime")
      .eq("id", event.messageId)
      .eq("sender_id", senderId)
      .maybeSingle();
    if (error) return respond({ error: `Could not validate the group message: ${error.message}` }, 500);
    if (!message) return respond({ error: "The group message is missing or does not belong to you." }, 404);
    const { data: group, error: groupError } = await admin.from("community_groups")
      .select("name,community_id")
      .eq("id", message.group_id)
      .single();
    if (groupError) return respond({ error: `Could not load the group: ${groupError.message}` }, 500);
    const { data: members, error: membersError } = await admin.from("community_members")
      .select("user_id")
      .eq("community_id", group.community_id)
      .neq("user_id", senderId);
    if (membersError) return respond({ error: `Could not load community members: ${membersError.message}` }, 500);
    for (const member of members || []) recipients.add(member.user_id);
    const { data: sender, error: profileError } = await admin.from("profiles")
      .select("name")
      .eq("id", senderId)
      .single();
    if (profileError) return respond({ error: `Could not load the sender profile: ${profileError.message}` }, 500);
    const body = message.attachment_mime?.startsWith("image/")
      ? "Photo"
      : message.attachment_mime?.startsWith("video/")
        ? "Video"
        : message.attachment_mime?.startsWith("audio/")
          ? "Voice message"
          : message.text || "New message";
    payload = {
      kind: "group-message",
      title: `${sender.name} · ${group.name}`,
      body,
      groupId: message.group_id,
      tag: `mingle-group-${message.group_id}`
    };
  } else {
    return respond({ error: "Unsupported push event." }, 400);
  }

  if (!recipients.size) return respond({ delivered: 0, message: "There are no recipients." });
  const { data: subscriptions, error: subscriptionsError } = await admin.from("push_subscriptions")
    .select("endpoint,p256dh,auth,platform")
    .in("user_id", [...recipients]);
  if (subscriptionsError) return respond({ error: `Could not load push subscriptions: ${subscriptionsError.message}` }, 500);
  if (!subscriptions?.length) return respond({ delivered: 0, message: "Recipients have no registered web push devices." });

  const webSubscriptions = subscriptions.filter((subscription) => subscription.platform === "web");
  const fcmSubscriptions = subscriptions.filter((subscription) => subscription.platform === "fcm");
  if (webSubscriptions.length && (!vapidPublicKey || !vapidPrivateKey || !vapidSubject)) {
    return respond({ error: "Web push is not configured. Set the VAPID function secrets." }, 503);
  }
  if (webSubscriptions.length) webPush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
  const results = await Promise.all(webSubscriptions.map(async (subscription) => {
    try {
      await webPush.sendNotification({
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth }
      }, JSON.stringify(payload));
      return { endpoint: subscription.endpoint, ok: true };
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        const { error: deleteError } = await admin.from("push_subscriptions")
          .delete()
          .eq("endpoint", subscription.endpoint);
        if (deleteError) console.error("Could not remove expired push subscription:", deleteError.message);
        return { endpoint: subscription.endpoint, ok: false };
      }
      console.error("Web push delivery failed:", error);
      return { endpoint: subscription.endpoint, ok: false };
    }
  }));
  const fcmResults = await sendFirebasePush(fcmSubscriptions, payload, admin);
  results.push(...fcmResults);
  const delivered = results.filter((result) => result.ok).length;
  const failed = results.length - delivered;
  return respond({ delivered, failed }, failed ? 502 : 200);
});

async function sendFirebasePush(
  subscriptions: Array<{ endpoint: string }>,
  payload: Record<string, unknown>,
  admin: SupabaseClient
) {
  if (!subscriptions.length) return [];
  const serviceAccountJson = Deno.env.get("FCM_SERVICE_ACCOUNT_JSON");
  if (!serviceAccountJson) {
    console.error("FCM subscriptions exist but FCM_SERVICE_ACCOUNT_JSON is not configured.");
    return subscriptions.map((subscription) => ({ endpoint: subscription.endpoint, ok: false }));
  }
  let serviceAccount: { client_email: string; private_key: string; project_id: string };
  try {
    serviceAccount = JSON.parse(serviceAccountJson);
  } catch {
    console.error("FCM_SERVICE_ACCOUNT_JSON is not valid JSON.");
    return subscriptions.map((subscription) => ({ endpoint: subscription.endpoint, ok: false }));
  }
  if (!serviceAccount.client_email || !serviceAccount.private_key || !serviceAccount.project_id) {
    console.error("FCM_SERVICE_ACCOUNT_JSON is missing client_email, private_key, or project_id.");
    return subscriptions.map((subscription) => ({ endpoint: subscription.endpoint, ok: false }));
  }
  const accessToken = await getGoogleAccessToken(serviceAccount);
  const messageData = Object.fromEntries(
    Object.entries(payload).map(([key, value]) => [key, String(value)])
  );
  return Promise.all(subscriptions.map(async (subscription) => {
    try {
      const response = await fetch(`https://fcm.googleapis.com/v1/projects/${serviceAccount.project_id}/messages:send`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          message: {
            token: subscription.endpoint,
            data: messageData,
            android: { priority: "HIGH" }
          }
        })
      });
      if (!response.ok) {
        const errorBody = await response.text();
        console.error("FCM delivery failed:", response.status, errorBody);
        if (response.status === 404 || response.status === 400 && errorBody.includes("UNREGISTERED")) {
          const { error } = await admin.from("push_subscriptions")
            .delete()
            .eq("endpoint", subscription.endpoint);
          if (error) console.error("Could not remove expired FCM token:", error.message);
          return { endpoint: subscription.endpoint, ok: false };
        }
        return { endpoint: subscription.endpoint, ok: false };
      }
      return { endpoint: subscription.endpoint, ok: true };
    } catch (error) {
      console.error("FCM request failed:", error);
      return { endpoint: subscription.endpoint, ok: false };
    }
  }));
}

async function getGoogleAccessToken(serviceAccount: {
  client_email: string;
  private_key: string;
}) {
  const now = Math.floor(Date.now() / 1000);
  const base64Url = (value: string | Uint8Array) => {
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  };
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64Url(JSON.stringify({
    iss: serviceAccount.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600
  }));
  const assertion = `${header}.${claims}`;
  const pem = serviceAccount.private_key.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
  const keyBytes = Uint8Array.from(atob(pem), (character) => character.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", keyBytes, {
    name: "RSASSA-PKCS1-v1_5",
    hash: "SHA-256"
  }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(assertion)));
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${assertion}.${base64Url(signature)}`
    })
  });
  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Google token exchange failed (${response.status}): ${errorBody}`);
  }
  const tokenData = await response.json();
  if (!tokenData.access_token) throw new Error("Google did not return an FCM access token.");
  return tokenData.access_token as string;
}
