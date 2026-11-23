import { createClient } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL, WEB_PUSH_PUBLIC_KEY } from "./supabase-config.js";

const $ = (selector) => document.querySelector(selector);
const authScreen = $("#authScreen");
const appShell = $("#appShell");
const messenger = $("#messenger");
const authForm = $("#authForm");
const authError = $("#authError");
const authSubmit = $("#authSubmit");
const emailInput = $("#emailAddress");
const phoneInput = $("#phoneNumber");
const passwordInput = $("#password");
const displayNameInput = $("#displayName");
const nameField = $("#nameField");
const chatList = $("#chatList");
const contentPanel = $("#contentPanel");
const dialog = $("#newChatDialog");
const identifierInput = $("#identifierInput");
const dialogError = $("#dialogError");
const toast = $("#toast");
const callDialog = $("#callDialog");
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
const MAX_VIDEO_SIZE = 25 * 1024 * 1024;
const MAX_VOICE_SIZE = 25 * 1024 * 1024;
const MEDIA_BUCKET = "mingle-chat-media";
const settingsSections = [
  { id: "account", icon: "◉", title: "Account", description: "Profile details, password and sign out" },
  { id: "privacy", icon: "◇", title: "Privacy", description: "Discoverability, chat lock and message security" },
  { id: "chats", icon: "▤", title: "Chats", description: "Theme and chat wallpaper" },
  { id: "notifications", icon: "♧", title: "Notifications", description: "Message alerts and this device's permission" },
  { id: "storage", icon: "▦", title: "Storage and data", description: "Device storage and shared media limits" },
  { id: "help", icon: "?", title: "Help", description: "Setup information and Mingle details" },
  { id: "invite", icon: "↗", title: "Invite a friend", description: "Share the Mingle website" }
];

let authMode = "login";
let profile = null;
let chats = [];
let currentPeer = null;
let currentGroup = null;
let communities = [];
let currentPeerArchived = false;
let page = "chats";
let refreshTimer = null;
let liveChannel = null;
let messageTimer = null;
let toastTimer = null;
let lastChatRefreshError = null;
let lastMessageLoadError = null;
let archivedView = false;
let mediaRecorder = null;
let recordingStream = null;
let recordingTimer = null;
let recordingTarget = null;
let recordedChunks = [];
let recordingStarting = false;
let incomingCallChannel = null;
let activeCall = null;
let ringtoneContext = null;
let ringtoneTimer = null;
const unlockedPeerIds = new Set();
const signedMediaUrls = new Map();

function isPublicSupabaseKey(key) {
  if (key.startsWith("sb_publishable_")) return true;
  const encodedPayload = key.split(".")[1];
  if (!encodedPayload) return false;

  try {
    const paddedPayload = encodedPayload.replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(paddedPayload + "=".repeat((4 - paddedPayload.length % 4) % 4)));
    return payload.role === "anon";
  } catch {
    return false;
  }
}

function createSupabaseClient() {
  const url = SUPABASE_URL.trim();
  const key = SUPABASE_ANON_KEY.trim();
  if (!url || !isPublicSupabaseKey(key)) return null;

  try {
    const projectUrl = new URL(url);
    if (projectUrl.protocol !== "https:" || projectUrl.username || projectUrl.password) return null;
    return createClient(projectUrl.toString(), key);
  } catch (error) {
    console.error("Could not initialize Supabase. Check the public project settings:", error);
    return null;
  }
}

const supabase = createSupabaseClient();

const escapeText = (text) => String(text).replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
})[character]);

function db() {
  if (!supabase) {
    throw new Error("Chat is not configured yet. Ask the site owner to finish the Supabase setup.");
  }
  return supabase;
}

function mapProfile(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    email: row.email,
    createdAt: row.created_at
  };
}

function mapMessage(row) {
  return {
    id: row.id,
    senderId: row.sender_id,
    recipientId: row.recipient_id,
    text: row.text,
    createdAt: row.created_at,
    readAt: row.read_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    attachmentPath: row.attachment_path,
    attachmentName: row.attachment_name,
    attachmentMime: row.attachment_mime,
    attachmentSize: row.attachment_size,
    groupId: row.group_id || null,
    senderName: row.sender_name || null
  };
}

function isAllowedMediaType(mimeType) {
  return [
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
    "video/mp4",
    "video/webm",
    "video/quicktime",
    "audio/webm",
    "audio/ogg",
    "audio/mp4",
    "audio/mpeg"
  ].includes(mimeType);
}

function mediaExtension(mimeType) {
  return {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
    "audio/webm": "webm",
    "audio/ogg": "ogg",
    "audio/mp4": "m4a",
    "audio/mpeg": "mp3"
  }[mimeType];
}

function isCurrentConversation(target) {
  return target?.kind === "group"
    ? currentGroup?.id === target.id
    : currentPeer?.id === target?.id;
}

function currentConversationTarget() {
  if (currentGroup) return { kind: "group", id: currentGroup.id, name: currentGroup.name };
  if (currentPeer) return { kind: "direct", id: currentPeer.id, name: currentPeer.name };
  return null;
}

async function getSignedMediaUrl(path) {
  const cached = signedMediaUrls.get(path);
  if (cached && cached.expiresAt > Date.now()) return cached.url;

  const { data, error } = await db().storage.from(MEDIA_BUCKET).createSignedUrl(path, 3600);
  if (error) throw new Error(error.message);
  if (!data?.signedUrl) throw new Error("The media link could not be created.");
  signedMediaUrls.set(path, { url: data.signedUrl, expiresAt: Date.now() + 55 * 60 * 1000 });
  return data.signedUrl;
}

async function appendMessageAttachment(message, bubble) {
  if (!message.attachmentPath) return;
  const target = message.groupId
    ? { kind: "group", id: message.groupId }
    : { kind: "direct", id: message.senderId === profile.id ? message.recipientId : message.senderId };
  if (!isCurrentConversation(target)) return;

  try {
    const url = await getSignedMediaUrl(message.attachmentPath);
    if (!isCurrentConversation(target)) return;
    if (message.attachmentMime.startsWith("image/")) {
      const link = document.createElement("a");
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.setAttribute("aria-label", `Open photo ${message.attachmentName}`);
      const image = document.createElement("img");
      image.className = "message-image";
      image.src = url;
      image.alt = message.attachmentName || "Shared photo";
      image.loading = "lazy";
      link.append(image);
      bubble.prepend(link);
      return;
    }

    if (message.attachmentMime.startsWith("audio/")) {
      const audio = document.createElement("audio");
      audio.className = "message-audio";
      audio.src = url;
      audio.controls = true;
      audio.preload = "metadata";
      audio.setAttribute("aria-label", message.attachmentName || "Voice message");
      bubble.prepend(audio);
    } else {
      const video = document.createElement("video");
      video.className = "message-video";
      video.src = url;
      video.controls = true;
      video.playsInline = true;
      video.preload = "metadata";
      video.setAttribute("aria-label", message.attachmentName || "Shared video");
      bubble.prepend(video);
    }
  } catch (error) {
    console.error("Could not load a chat attachment:", error);
    const unavailable = document.createElement("div");
    unavailable.className = "deleted-message";
    unavailable.textContent = "This attachment could not be loaded.";
    bubble.prepend(unavailable);
    showToast(`Could not load attachment: ${error.message}`);
  }
}

function loginEmail(phone) {
  return `m${phone}@accounts.mingle.invalid`;
}

async function getMyProfile() {
  const client = db();
  const { data: userData, error: userError } = await client.auth.getUser();
  if (userError) throw new Error(userError.message);
  if (!userData.user) throw new Error("Your account session expired. Please log in again.");

  const { data: existingProfile, error: profileError } = await client
    .from("profiles")
    .select("*")
    .eq("id", userData.user.id)
    .maybeSingle();
  if (profileError) throw new Error(`Could not load your account profile: ${profileError.message}`);

  if (existingProfile) {
    const authEmail = userData.user.email?.trim().toLowerCase() || "";
    const email = /^m[0-9]{10}@accounts\.mingle\.invalid$/.test(authEmail)
      ? existingProfile.email
      : authEmail || existingProfile.email;
    return mapProfile({ ...existingProfile, email });
  }

  const { data, error } = await client.rpc("ensure_my_profile");
  if (error) {
    if (error.message.includes("This account does not use a valid Mingle mobile number.")) {
      throw new Error("Your Mingle database still has the old login setup. In Supabase, open SQL Editor and run the latest chat-app/supabase/schema.sql file, then log in again. Your account and chats will not be deleted.");
    }
    throw new Error(error.message);
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error("Your account profile could not be loaded. Please log in again.");
  return mapProfile(row);
}

function normalizeContactIdentifier(identifier) {
  const cleanedIdentifier = identifier.trim();
  const compactIdentifier = cleanedIdentifier.replace(/[\s().-]/g, "");
  if (/^0\d{10}$/.test(compactIdentifier)) return compactIdentifier.slice(1);
  if (/^\d{10}$/.test(compactIdentifier)) return compactIdentifier;
  return cleanedIdentifier.toLowerCase();
}

async function findProfile(identifier) {
  const normalizedIdentifier = normalizeContactIdentifier(identifier);
  const { data, error } = await db().rpc("lookup_profile", { p_identifier: normalizedIdentifier });
  if (error) {
    if (error.code === "PGRST202" || /function .*lookup_profile.*(not found|does not exist)/i.test(error.message)) {
      throw new Error("Contact search is not set up in this database yet. In Supabase SQL Editor, run the latest chat-app/supabase/schema.sql file, then try again.");
    }
    throw new Error(error.message);
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error("No Mingle account matches that number or email. Check the exact number and make sure the person has a Mingle account in this project.");
  return mapProfile(row);
}

function showAuthError(message) {
  authError.textContent = message;
  authError.classList.remove("success");
  authError.classList.add("error");
  authError.hidden = false;
  $("#existingAccountActions").hidden = true;
}

function showExistingAccountOptions(message) {
  showAuthError(message);
  $("#existingAccountActions").hidden = false;
}

function initials(name) {
  return String(name || "?").trim().split(/\s+/).slice(0, 2).map((part) => part[0] || "").join("").toUpperCase();
}

function timeLabel(value) {
  if (!value) return "";
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? "" : new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(time);
}

function setAuthMode(mode) {
  authMode = mode;
  const create = mode === "create";
  $("#authTitle").textContent = create ? "Create your account" : "Welcome to Mingle";
  $("#authDescription").textContent = create
    ? "Choose a name, unique mobile number and password."
    : "Log in to get back to your conversations.";
  nameField.hidden = !create;
  $("#phoneField").hidden = !create;
  phoneInput.required = create;
  emailInput.labels[0].textContent = create ? "Email address" : "Email address or old mobile number";
  emailInput.type = create ? "email" : "text";
  emailInput.autocomplete = create ? "email" : "username";
  emailInput.placeholder = create ? "Enter your email" : "Enter your email or old mobile number";
  emailInput.inputMode = create ? "email" : "text";
  displayNameInput.required = create;
  passwordInput.autocomplete = create ? "new-password" : "current-password";
  passwordInput.minLength = create ? 8 : 8;
  authSubmit.textContent = create ? "Create account" : "Log in";
  $("#forgotPasswordButton").hidden = create;
  $("#loginTab").classList.toggle("active", !create);
  $("#createTab").classList.toggle("active", create);
  $("#loginTab").setAttribute("aria-selected", String(!create));
  $("#createTab").setAttribute("aria-selected", String(create));
  emailInput.value = "";
  phoneInput.value = "";
  passwordInput.value = "";
  authError.hidden = true;
  $("#existingAccountActions").hidden = true;
}

function updateNav(activePage) {
  document.querySelectorAll(".nav-button").forEach((button) => {
    button.classList.toggle("active", button.dataset.page === activePage);
  });
}

function showToast(message, identifier = null) {
  toast.replaceChildren();
  toast.append(document.createTextNode(message));
  if (identifier) {
    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.textContent = "Open chat";
    openButton.addEventListener("click", () => void openChat(identifier));
    toast.append(openButton);
  }
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 8000);
}

function playNotification() {
  if ("Notification" in window
    && Notification.permission === "granted"
    && document.hidden
    && getPreference("mingle-message-sound", "on") !== "off") {
    return true;
  }
  return false;
}

function notifyIncoming(event) {
  if (currentPeer?.id === event.senderId) {
    void loadMessages();
    return;
  }

  if (playNotification()) {
    void showIncomingNotification(event);
  } else {
    showToast(`${event.senderName}: ${event.preview}`, event.senderPhone);
  }
}

async function showIncomingNotification(event) {
  const options = {
    body: event.preview,
    icon: "./icon.svg",
    tag: `mingle-${event.senderPhone}`,
    data: { chat: event.senderPhone },
    silent: false,
    vibrate: [180, 90, 180]
  };
  try {
    if ("serviceWorker" in navigator) {
      const registration = await navigator.serviceWorker.ready;
      await registration.showNotification(event.senderName, options);
      return;
    }
    const notification = new Notification(event.senderName, options);
    notification.onclick = () => {
      window.focus();
      void openChat(event.senderPhone);
      notification.close();
    };
  } catch (error) {
    console.error("Could not display the incoming-message notification:", error);
    showToast(`Could not display notification: ${error.message}`, event.senderPhone);
  }
}

function startIncomingCallListener() {
  if (incomingCallChannel) void db().removeChannel(incomingCallChannel);
  incomingCallChannel = db()
    .channel(`incoming-calls:${profile.id}`)
    .on("postgres_changes", {
      event: "INSERT",
      schema: "public",
      table: "call_sessions",
      filter: `callee_id=eq.${profile.id}`
    }, (payload) => {
      void handleIncomingCall(payload.new).catch((error) => {
        console.error("Could not open an incoming call:", error);
        showToast(`Could not open incoming call: ${error.message}`);
      });
    })
    .subscribe();
}

async function handleIncomingCall(row) {
  if (!row?.id || row.callee_id !== profile?.id || Date.now() - new Date(row.created_at).getTime() > 90000) return;
  if (activeCall?.id === row.id) return;
  if (activeCall) {
    const { error } = await db().from("call_signals").insert({
      call_id: row.id,
      sender_id: profile.id,
      signal_type: "reject",
      payload: { reason: "busy" }
    });
    if (error) console.error("Could not reject a busy incoming call:", error.message);
    return;
  }
  const peer = chats.find((chat) => chat.id === row.caller_id) || { id: row.caller_id, name: "Mingle member" };
  activeCall = {
    id: row.id,
    peer,
    mediaType: row.media_type,
    role: "callee",
    pc: null,
    localStream: null,
    signalChannel: null,
    pendingCandidates: [],
    seenSignalIds: new Set(),
    ringTimeout: null
  };
  await subscribeToCallSignals(activeCall);
  showCallPanel(true, `Incoming ${row.media_type === "video" ? "video" : "voice"} call`, "Accept or decline the call");
  startRingtone();
  if (document.hidden && Notification.permission === "granted" && "serviceWorker" in navigator) {
    try {
      const registration = await navigator.serviceWorker.ready;
      await registration.showNotification(`${peer.name} is calling`, {
        body: row.media_type === "video" ? "Incoming video call" : "Incoming voice call",
        icon: "./icon.svg",
        tag: `mingle-call-${row.id}`,
        requireInteraction: true,
        silent: false,
        vibrate: [350, 160, 350, 160, 500],
        data: { callId: row.id }
      });
    } catch (error) {
      console.error("Could not display the incoming call notification:", error);
    }
  }
  activeCall.ringTimeout = setTimeout(() => {
    if (activeCall?.id === row.id) void rejectCall("missed");
  }, 45000);
}

async function subscribeToCallSignals(call) {
  const channel = db()
    .channel(`call-signals:${call.id}`)
    .on("postgres_changes", {
      event: "INSERT",
      schema: "public",
      table: "call_signals",
      filter: `call_id=eq.${call.id}`
    }, (payload) => {
      void handleCallSignal(call, payload.new).catch((error) => {
        console.error("Could not process call signaling:", error);
        showToast(`Call connection error: ${error.message}`);
      });
    });
  call.signalChannel = channel;
  await new Promise((resolve, reject) => {
    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") resolve();
      else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        reject(new Error(`Call signaling channel ${status.toLowerCase()}.`));
      }
    });
  });
  const { data, error } = await db().from("call_signals")
    .select("id,call_id,sender_id,signal_type,payload,created_at")
    .eq("call_id", call.id)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  for (const signal of data || []) await handleCallSignal(call, signal);
}

async function handleCallSignal(call, signal) {
  if (!activeCall || activeCall.id !== call.id || signal.sender_id === profile.id || call.seenSignalIds.has(signal.id)) return;
  call.seenSignalIds.add(signal.id);
  if (signal.signal_type === "offer" && call.role === "callee") {
    call.offer = signal.payload;
  } else if (signal.signal_type === "answer" && call.role === "caller" && call.pc && !call.pc.remoteDescription) {
    await call.pc.setRemoteDescription(new RTCSessionDescription(signal.payload));
    await flushRemoteCandidates(call);
    $("#callStatus").textContent = "Connecting…";
  } else if (signal.signal_type === "candidate") {
    if (!call.pc?.remoteDescription) call.pendingCandidates.push(signal.payload);
    else await call.pc.addIceCandidate(new RTCIceCandidate(signal.payload));
  } else if (signal.signal_type === "accept" && call.role === "caller") {
    $("#callStatus").textContent = "Call accepted · connecting…";
  } else if (signal.signal_type === "reject") {
    await closeActiveCall(false, signal.payload?.reason === "missed" ? "No answer" : "Call declined");
  } else if (signal.signal_type === "end") {
    await closeActiveCall(false, "Call ended");
  }
}

async function flushRemoteCandidates(call) {
  const queued = call.pendingCandidates.splice(0);
  for (const candidate of queued) await call.pc.addIceCandidate(new RTCIceCandidate(candidate));
}

function createCallPeerConnection(call, stream) {
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
  });
  call.pc = pc;
  call.localStream = stream;
  for (const track of stream.getTracks()) pc.addTrack(track, stream);
  pc.onicecandidate = (event) => {
    if (event.candidate && activeCall?.id === call.id) {
      void sendCallSignal(call, "candidate", event.candidate.toJSON()).catch((error) => {
        console.error("Could not send an ICE candidate:", error);
      });
    }
  };
  pc.ontrack = (event) => {
    const remoteStream = event.streams[0];
    if (!remoteStream) return;
    $("#remoteAudio").srcObject = remoteStream;
    $("#remoteVideo").srcObject = remoteStream;
    $("#remoteVideo").hidden = !remoteStream.getVideoTracks().length;
    $("#audioCallAvatar").hidden = remoteStream.getVideoTracks().length > 0;
  };
  pc.onconnectionstatechange = () => {
    if (activeCall?.id !== call.id) return;
    if (pc.connectionState === "connected") {
      $("#callStatus").textContent = "Connected";
      stopRingtone();
    } else if (pc.connectionState === "failed") {
      $("#callStatus").textContent = "Connection failed. Check both internet connections and try again.";
    } else if (pc.connectionState === "disconnected") {
      $("#callStatus").textContent = "Connection interrupted…";
    }
  };
}

function showCallPanel(incoming, title, status) {
  const call = activeCall;
  if (!call) return;
  $("#callTitle").textContent = title;
  $("#callStatus").textContent = status;
  $("#audioCallAvatar").textContent = initials(call.peer.name);
  $("#acceptCallButton").hidden = !incoming;
  $("#declineCallButton").hidden = !incoming;
  $("#hangUpButton").hidden = incoming;
  $("#remoteVideo").hidden = true;
  $("#localVideo").hidden = true;
  $("#remoteAudio").srcObject = null;
  $("#remoteVideo").srcObject = null;
  $("#localVideo").srcObject = null;
  if (!callDialog.open) callDialog.showModal();
}

async function startCall(mediaType, peer) {
  if (activeCall) {
    showToast("Finish your current call before starting another one.");
    return;
  }
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) {
    showToast("Calls need HTTPS and a browser that supports audio/video calls.");
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: mediaType === "video"
    });
    const { data: session, error } = await db().from("call_sessions").insert({
      caller_id: profile.id,
      callee_id: peer.id,
      media_type: mediaType
    }).select("id").single();
    if (error) throw new Error(error.message);
    const call = {
      id: session.id,
      peer,
      mediaType,
      role: "caller",
      pc: null,
      localStream: stream,
      signalChannel: null,
      pendingCandidates: [],
      seenSignalIds: new Set(),
      ringTimeout: null
    };
    activeCall = call;
    showCallPanel(false, `${mediaType === "video" ? "Video" : "Voice"} call · ${peer.name}`, "Calling…");
    createCallPeerConnection(call, stream);
    if (mediaType === "video") {
      $("#localVideo").srcObject = stream;
      $("#localVideo").hidden = false;
    }
    await subscribeToCallSignals(call);
    const offer = await call.pc.createOffer();
    await call.pc.setLocalDescription(offer);
    await sendCallSignal(call, "offer", { type: call.pc.localDescription.type, sdp: call.pc.localDescription.sdp });
    call.ringTimeout = setTimeout(() => {
      if (activeCall?.id === call.id) void closeActiveCall(true, "No answer");
    }, 45000);
    void sendPushEvent({ kind: "incoming-call", callId: call.id });
  } catch (error) {
    stream?.getTracks().forEach((track) => track.stop());
    console.error("Could not start the call:", error);
    if (activeCall) await closeActiveCall(false, "Call could not start");
    else showToast(`Could not start call: ${error.message}`);
  }
}

async function acceptIncomingCall() {
  const call = activeCall;
  if (!call || call.role !== "callee") return;
  clearTimeout(call.ringTimeout);
  stopRingtone();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: call.mediaType === "video"
    });
    createCallPeerConnection(call, stream);
    if (call.mediaType === "video") {
      $("#localVideo").srcObject = stream;
      $("#localVideo").hidden = false;
    }
    const { data: offers, error } = await db().from("call_signals")
      .select("payload")
      .eq("call_id", call.id)
      .eq("signal_type", "offer")
      .order("created_at", { ascending: true })
      .limit(1);
    if (error) throw new Error(error.message);
    const offer = offers?.[0]?.payload || call.offer;
    if (!offer) throw new Error("The caller's offer has not arrived yet. Please try accepting again.");
    await sendCallSignal(call, "accept", {});
    await call.pc.setRemoteDescription(new RTCSessionDescription(offer));
    await flushRemoteCandidates(call);
    const answer = await call.pc.createAnswer();
    await call.pc.setLocalDescription(answer);
    await sendCallSignal(call, "answer", { type: call.pc.localDescription.type, sdp: call.pc.localDescription.sdp });
    showCallPanel(false, `${call.mediaType === "video" ? "Video" : "Voice"} call · ${call.peer.name}`, "Connecting…");
    if (call.mediaType === "video") {
      $("#localVideo").srcObject = stream;
      $("#localVideo").hidden = false;
    }
  } catch (error) {
    console.error("Could not accept the call:", error);
    showToast(`Could not accept call: ${error.message}`);
    await closeActiveCall(true, "Call could not connect");
  }
}

async function rejectCall(reason = "declined") {
  const call = activeCall;
  if (!call) return;
  try {
    await sendCallSignal(call, "reject", { reason });
  } catch (error) {
    console.error("Could not send call rejection:", error);
    showToast(`Could not notify the caller: ${error.message}`);
  }
  await closeActiveCall(false, reason === "missed" ? "Missed call" : "Call declined");
}

async function sendCallSignal(call, signalType, payload) {
  const { error } = await db().from("call_signals").insert({
    call_id: call.id,
    sender_id: profile.id,
    signal_type: signalType,
    payload
  });
  if (error) throw new Error(error.message);
}

async function closeActiveCall(notifyPeer, status) {
  const call = activeCall;
  if (!call) return;
  activeCall = null;
  clearTimeout(call.ringTimeout);
  stopRingtone();
  if (notifyPeer) {
    try {
      await sendCallSignal(call, "end", {});
    } catch (error) {
      console.error("Could not send call termination signal:", error);
      showToast(`Call ended locally, but the other device may not be notified: ${error.message}`);
    }
  }
  if (call.signalChannel) await db().removeChannel(call.signalChannel);
  call.pc?.close();
  call.localStream?.getTracks().forEach((track) => track.stop());
  $("#remoteAudio").srcObject = null;
  $("#remoteVideo").srcObject = null;
  $("#localVideo").srcObject = null;
  if (callDialog.open) callDialog.close();
  if (status && status !== "Call ended") showToast(status);
}

function startRingtone() {
  if (getPreference("mingle-call-ringtone", "on") === "off") return;
  stopRingtone();
  const ring = () => {
    try {
      const AudioContextType = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextType) return;
      ringtoneContext ||= new AudioContextType();
      if (ringtoneContext.state === "suspended") void ringtoneContext.resume();
      const start = ringtoneContext.currentTime;
      for (const [offset, frequency] of [[0, 880], [0.24, 660]]) {
        const oscillator = ringtoneContext.createOscillator();
        const gain = ringtoneContext.createGain();
        oscillator.frequency.value = frequency;
        gain.gain.setValueAtTime(0.001, start + offset);
        gain.gain.exponentialRampToValueAtTime(0.12, start + offset + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, start + offset + 0.18);
        oscillator.connect(gain);
        gain.connect(ringtoneContext.destination);
        oscillator.start(start + offset);
        oscillator.stop(start + offset + 0.2);
      }
    } catch (error) {
      console.warn("The in-app call ringtone could not play:", error);
    }
  };
  ring();
  ringtoneTimer = setInterval(ring, 1700);
}

function stopRingtone() {
  clearInterval(ringtoneTimer);
  ringtoneTimer = null;
}

async function sendPushEvent(event) {
  if (!WEB_PUSH_PUBLIC_KEY && !window.MingleAndroid) return;
  const { error } = await db().functions.invoke("send-push", { body: event });
  if (error) {
    console.error("Background push delivery could not be requested:", error);
    showToast(`${event.kind === "incoming-call" ? "The call is ringing" : "Your message was sent"}, but background notification failed: ${error.message}`);
  }
}

function messagePreview(message) {
  if (message.attachment_mime?.startsWith("image/")) return "Photo";
  if (message.attachment_mime?.startsWith("video/")) return "Video";
  if (message.attachment_mime?.startsWith("audio/")) return "Voice message";
  return message.text || "New message";
}

function startLiveConnection() {
  if (liveChannel) void db().removeChannel(liveChannel);
  liveChannel = db()
    .channel(`messages:${profile.id}`)
    .on("postgres_changes", {
      event: "INSERT",
      schema: "public",
      table: "messages",
      filter: `recipient_id=eq.${profile.id}`
    }, (payload) => {
      void (async () => {
        await refreshChats();
        let sender = chats.find((chat) => chat.id === payload.new.sender_id);
        if (!sender) {
          const { data: archived, error } = await db().rpc("get_chat_summaries", { p_archived: true });
          if (error) throw new Error(error.message);
          sender = (archived || []).find((chat) => chat.id === payload.new.sender_id);
        }
        if (!sender) return;
        notifyIncoming({
          senderId: sender.id,
          senderName: sender.name,
          senderPhone: sender.phone,
          preview: messagePreview(payload.new)
        });
      })().catch((error) => console.error("Could not process an incoming message:", error));
    })
    .on("postgres_changes", {
      event: "UPDATE",
      schema: "public",
      table: "messages",
      filter: `sender_id=eq.${profile.id}`
    }, (payload) => {
      if (currentPeer?.id === payload.new.recipient_id) void loadMessages();
      void refreshChats();
    })
    .on("postgres_changes", {
      event: "UPDATE",
      schema: "public",
      table: "messages",
      filter: `recipient_id=eq.${profile.id}`
    }, (payload) => {
      if (currentPeer?.id === payload.new.sender_id) void loadMessages();
      void refreshChats();
    })
    .on("postgres_changes", {
      event: "*",
      schema: "public",
      table: "group_messages"
    }, (payload) => {
      if (currentGroup?.id === (payload.new?.group_id || payload.old?.group_id)) void loadMessages();
    })
    .on("postgres_changes", {
      event: "INSERT",
      schema: "public",
      table: "community_members",
      filter: `user_id=eq.${profile.id}`
    }, () => void refreshGroups())
    .on("postgres_changes", {
      event: "INSERT",
      schema: "public",
      table: "community_groups"
    }, () => void refreshGroups())
    .subscribe((status, error) => {
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        console.error("The live chat connection failed:", error?.message || status);
      }
    });
}

async function refreshChats() {
  if (!profile) return;
  try {
    const { data, error } = await db().rpc("get_chat_summaries", { p_archived: archivedView });
    if (error) throw new Error(error.message);
    chats = (data || []).map((chat) => ({
      id: chat.id,
      name: chat.name,
      phone: chat.phone,
      email: chat.email,
      createdAt: chat.created_at,
      lastMessage: chat.last_message,
      lastSenderId: chat.last_sender_id,
      updatedAt: chat.updated_at,
      unread: Number(chat.unread)
    }));
    lastChatRefreshError = null;
    renderChats();
  } catch (error) {
    console.error("Could not refresh chats:", error);
    if (lastChatRefreshError !== error.message) showToast(`Could not load chats: ${error.message}`);
    lastChatRefreshError = error.message;
  }
}

function renderChats() {
  if (page === "groups") {
    renderGroups();
    return;
  }
  chatList.replaceChildren();
  const search = $("#searchInput").value.trim().toLowerCase();
  let lockedPeers = new Set();
  try {
    lockedPeers = getLockedPeerIds();
  } catch (error) {
    console.error("Could not read the device's locked chats:", error);
    showToast(error.message);
  }
  const visible = chats.filter((chat) => {
    const searchable = `${chat.name} ${chat.phone} ${chat.email || ""}${lockedPeers.has(chat.id) ? "" : ` ${chat.lastMessage || ""}`}`;
    return searchable.toLowerCase().includes(search);
  });
  $("#chatCount").textContent = String(visible.length);
  $("#listTitle").textContent = archivedView ? "Archived chats" : "Messages";
  $("#archiveViewButton").textContent = archivedView ? "Back to messages" : "Archived";
  $("#archiveViewButton").hidden = page === "groups";
  $("#newChatButton").title = page === "groups" ? "Create a community" : "Start a chat";
  $("#newChatButton").setAttribute("aria-label", page === "groups" ? "Create a private community" : "Find someone by phone or email");

  for (const chat of visible) {
    const container = document.createElement("div");
    container.className = "chat-row-container";
    const row = document.createElement("button");
    row.type = "button";
    row.className = `chat-row${currentPeer?.id === chat.id ? " selected" : ""}`;
    row.setAttribute("aria-label", `Open conversation with ${chat.name}`);
    const isLocked = lockedPeers.has(chat.id);
    const preview = isLocked
      ? "Locked chat"
      : chat.lastMessage
      ? `${chat.lastSenderId === profile.id ? "You: " : ""}${chat.lastMessage}`
      : `Mobile ${chat.phone}`;
    const secureLabel = isLocked ? " 🔒" : "";
    row.innerHTML = `<span class="avatar">${escapeText(initials(chat.name))}</span>
      <span class="row-copy">
        <span class="row-top"><span class="row-name">${escapeText(chat.name)}</span><span class="row-time">${escapeText(timeLabel(chat.updatedAt))}</span></span>
        <span class="row-bottom"><span class="row-preview">${escapeText(preview + secureLabel)}</span>${chat.unread ? `<span class="unread-badge">${chat.unread > 99 ? "99+" : chat.unread}</span>` : ""}</span>
      </span>`;
    row.addEventListener("click", () => void openChat(chat.phone));
    const archiveButton = document.createElement("button");
    archiveButton.type = "button";
    archiveButton.className = "chat-archive-button";
    archiveButton.textContent = archivedView ? "Unarchive" : "Archive";
    archiveButton.setAttribute("aria-label", `${archivedView ? "Unarchive" : "Archive"} chat with ${chat.name}`);
    archiveButton.addEventListener("click", () => void setChatArchived(chat.id, !archivedView));
    container.append(row, archiveButton);
    chatList.append(container);
  }
  if (!visible.length) {
    const empty = document.createElement("div");
    empty.className = "empty-list";
    empty.textContent = search
      ? "No conversations match your search."
      : archivedView ? "No archived chats." : "No conversations yet. Select + to find someone by mobile number or email.";
    chatList.append(empty);
  }
}

async function refreshGroups() {
  if (!profile) return;
  try {
    const { data: memberships, error: membershipError } = await db()
      .from("community_members")
      .select("community_id,role")
      .eq("user_id", profile.id);
    if (membershipError) throw new Error(membershipError.message);

    const communityIds = (memberships || []).map((membership) => membership.community_id);
    if (!communityIds.length) {
      communities = [];
      if (page === "groups") renderGroups();
      return;
    }

    const [{ data: communityRows, error: communityError }, { data: groupRows, error: groupError }] = await Promise.all([
      db().from("communities").select("id,name,created_by,created_at").in("id", communityIds).order("created_at"),
      db().from("community_groups").select("id,community_id,name,created_by,created_at").in("community_id", communityIds).order("created_at")
    ]);
    if (communityError) throw new Error(communityError.message);
    if (groupError) throw new Error(groupError.message);

    communities = (communityRows || []).map((community) => ({
      ...community,
      role: memberships.find((membership) => membership.community_id === community.id)?.role || "member",
      groups: (groupRows || []).filter((group) => group.community_id === community.id)
    }));
    if (page === "groups") renderGroups();
  } catch (error) {
    console.error("Could not refresh communities:", error);
    showToast(`Could not load communities: ${error.message}`);
  }
}

function renderGroups() {
  chatList.replaceChildren();
  const search = $("#searchInput").value.trim().toLowerCase();
  let visibleCount = 0;
  $("#listTitle").textContent = "Groups & communities";
  $("#archiveViewButton").hidden = true;
  $("#chatCount").textContent = "";
  $("#newChatButton").title = "Create a community";
  $("#newChatButton").setAttribute("aria-label", "Create a private community");

  for (const community of communities) {
    const matchingGroups = community.groups.filter((group) =>
      `${community.name} ${group.name}`.toLowerCase().includes(search));
    if (!community.name.toLowerCase().includes(search) && !matchingGroups.length) continue;
    visibleCount += 1;
    const section = document.createElement("section");
    section.className = "community-section";
    const heading = document.createElement("div");
    heading.className = "community-heading";
    const title = document.createElement("strong");
    title.textContent = community.name;
    heading.append(title);
    if (community.role === "owner" || community.role === "admin") {
      const actions = document.createElement("div");
      actions.className = "community-actions";
      const inviteButton = document.createElement("button");
      inviteButton.type = "button";
      inviteButton.textContent = "Invite";
      inviteButton.addEventListener("click", () => void inviteCommunityMember(community));
      const groupButton = document.createElement("button");
      groupButton.type = "button";
      groupButton.textContent = "+ Group";
      groupButton.addEventListener("click", () => void createCommunityGroup(community));
      actions.append(inviteButton, groupButton);
      heading.append(actions);
    }
    section.append(heading);

    for (const group of matchingGroups) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = `chat-row group-row${currentGroup?.id === group.id ? " selected" : ""}`;
      row.innerHTML = `<span class="avatar">${escapeText(initials(group.name))}</span>
        <span class="row-copy"><span class="row-name">${escapeText(group.name)}</span><span class="row-preview">Group · ${escapeText(community.name)}</span></span>`;
      row.setAttribute("aria-label", `Open ${group.name} group in ${community.name}`);
      row.addEventListener("click", () => void openGroup({ ...group, communityName: community.name }));
      section.append(row);
    }
    if (!matchingGroups.length && !search) {
      const empty = document.createElement("p");
      empty.className = "empty-community";
      empty.textContent = "No groups yet.";
      section.append(empty);
    }
    chatList.append(section);
  }

  const empty = document.createElement("div");
  empty.className = "empty-list";
  if (!communities.length) {
    empty.textContent = "Create a private community, then add groups and invite people by their Mingle phone number or email.";
    chatList.append(empty);
  } else if (!visibleCount) {
    empty.textContent = "No groups or communities match your search.";
    chatList.append(empty);
  } else if (search) {
    $("#chatCount").textContent = `${visibleCount} ${visibleCount === 1 ? "community" : "communities"}`;
  }
}

async function createCommunity() {
  const name = window.prompt("Choose a name for your private community.");
  if (name === null) return;
  try {
    const { error } = await db().rpc("create_community", { p_name: name.trim() });
    if (error) throw new Error(error.message);
    await refreshGroups();
    showToast(`Private community "${name.trim()}" created. Add a group and invite people.`);
  } catch (error) {
    showToast(`Could not create community: ${error.message}`);
  }
}

async function createCommunityGroup(community) {
  const name = window.prompt(`Choose a name for a group in "${community.name}".`);
  if (name === null) return;
  try {
    const { error } = await db().rpc("create_community_group", {
      p_community_id: community.id,
      p_name: name.trim()
    });
    if (error) throw new Error(error.message);
    await refreshGroups();
  } catch (error) {
    showToast(`Could not create group: ${error.message}`);
  }
}

async function inviteCommunityMember(community) {
  const identifier = window.prompt(`Enter the exact Mingle mobile number or email to invite to "${community.name}".`);
  if (identifier === null) return;
  try {
    const { error } = await db().rpc("add_community_member", {
      p_community_id: community.id,
      p_identifier: identifier.trim().toLowerCase()
    });
    if (error) throw new Error(error.message);
    await refreshGroups();
    showToast("Member added to the private community and its groups.");
  } catch (error) {
    showToast(`Could not invite member: ${error.message}`);
  }
}

function getLockedPeerIds() {
  const stored = localStorage.getItem(`mingle-locked-chats:${profile.id}`);
  const identifiers = stored ? JSON.parse(stored) : [];
  if (!Array.isArray(identifiers) || identifiers.some((id) => typeof id !== "string")) {
    throw new Error("The on-device locked-chat list is invalid. Clear this site's saved data and set up chat locks again.");
  }
  return new Set(identifiers);
}

function saveLockedPeerIds(peerIds) {
  localStorage.setItem(`mingle-locked-chats:${profile.id}`, JSON.stringify([...peerIds]));
}

async function hashLockPin(pin, salt) {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
  const result = await crypto.subtle.deriveBits({
    name: "PBKDF2",
    salt,
    iterations: 210000,
    hash: "SHA-256"
  }, material, 256);
  return Array.from(new Uint8Array(result), (value) => value.toString(16).padStart(2, "0")).join("");
}

async function unlockChat(peerId) {
  const lockedPeers = getLockedPeerIds();
  if (!lockedPeers.has(peerId) || unlockedPeerIds.has(peerId)) return true;

  const credentialKey = `mingle-lock-pin:${profile.id}`;
  let credential = localStorage.getItem(credentialKey);
  if (!credential) {
    lockedPeers.delete(peerId);
    saveLockedPeerIds(lockedPeers);
    showToast("Your local chat lock was reset because this device's PIN data was cleared.");
    return true;
  }

  try {
    credential = JSON.parse(credential);
    if (typeof credential.salt !== "string" || typeof credential.hash !== "string") {
      throw new Error("Invalid saved PIN.");
    }
  } catch (error) {
    throw new Error(`Could not read the chat-lock PIN on this device: ${error.message}`);
  }

  const pin = window.prompt("Enter your Mingle PIN to open this locked chat.");
  if (pin === null) return false;
  const suppliedHash = await hashLockPin(pin, Uint8Array.from(atob(credential.salt), (character) => character.charCodeAt(0)));
  if (suppliedHash !== credential.hash) {
    showToast("That PIN is incorrect.");
    return false;
  }

  unlockedPeerIds.add(peerId);
  return true;
}

async function toggleChatLock(peer) {
  try {
    const lockedPeers = getLockedPeerIds();
    if (lockedPeers.has(peer.id)) {
      lockedPeers.delete(peer.id);
      saveLockedPeerIds(lockedPeers);
      unlockedPeerIds.delete(peer.id);
      showToast(`${peer.name}'s chat is unlocked on this device.`);
      $("#lockChatButton").textContent = "Lock chat";
      renderChats();
      return;
    }

    if (!crypto.subtle) {
      throw new Error("This browser does not support a secure local chat lock.");
    }

    const credentialKey = `mingle-lock-pin:${profile.id}`;
    let credential = localStorage.getItem(credentialKey);
    if (!credential) {
      const pin = window.prompt("Create a 4-8 digit PIN for chats locked on this device.");
      if (pin === null) return;
      if (!/^[0-9]{4,8}$/.test(pin)) throw new Error("Choose a PIN containing 4 to 8 digits.");
      const confirmation = window.prompt("Enter the same PIN again.");
      if (confirmation === null) return;
      if (confirmation !== pin) throw new Error("The PINs do not match.");
      const salt = crypto.getRandomValues(new Uint8Array(16));
      credential = JSON.stringify({
        salt: btoa(String.fromCharCode(...salt)),
        hash: await hashLockPin(pin, salt)
      });
      localStorage.setItem(credentialKey, credential);
    }

    lockedPeers.add(peer.id);
    saveLockedPeerIds(lockedPeers);
    unlockedPeerIds.add(peer.id);
    showToast(`${peer.name}'s chat is locked on this device.`);
    $("#lockChatButton").textContent = "Unlock chat";
    renderChats();
  } catch (error) {
    showToast(error.message);
  }
}

async function setChatArchived(peerId, archived) {
  try {
    const query = archived
      ? db().from("chat_archives").insert({ user_id: profile.id, peer_id: peerId })
      : db().from("chat_archives").delete().eq("user_id", profile.id).eq("peer_id", peerId);
    const { error } = await query;
    if (error) throw new Error(error.message);
    if (currentPeer?.id === peerId) {
      currentPeerArchived = archived;
      $("#archiveChatButton").textContent = archived ? "Unarchive" : "Archive";
    }
    await refreshChats();
    if (currentPeer?.id === peerId && archived) {
      currentPeer = null;
      currentPeerArchived = false;
      clearInterval(messageTimer);
      messenger.classList.remove("show-chat");
      renderWelcome();
    }
  } catch (error) {
    showToast(`Could not ${archived ? "archive" : "unarchive"} this chat: ${error.message}`);
  }
}

function showLogin() {
  if (mediaRecorder?.state === "recording") stopVoiceRecording(true);
  if (liveChannel) void db().removeChannel(liveChannel);
  if (incomingCallChannel) void db().removeChannel(incomingCallChannel);
  if (activeCall) void closeActiveCall(false, null);
  liveChannel = null;
  incomingCallChannel = null;
  clearInterval(refreshTimer);
  clearInterval(messageTimer);
  profile = null;
  currentPeer = null;
  currentGroup = null;
  communities = [];
  currentPeerArchived = false;
  archivedView = false;
  page = "chats";
  chats = [];
  authScreen.hidden = false;
  appShell.hidden = true;
  messenger.classList.remove("show-chat", "show-page");
  passwordInput.value = "";
  unlockedPeerIds.clear();
  setAuthMode("login");
}

async function showApp(userProfile) {
  profile = userProfile;
  currentPeer = null;
  currentGroup = null;
  page = "chats";
  archivedView = false;
  authScreen.hidden = true;
  appShell.hidden = false;
  $("#listTitle").textContent = "Messages";
  $("#searchInput").parentElement.hidden = false;
  $("#newChatButton").hidden = false;
  messenger.classList.remove("show-chat", "show-page");
  await refreshChats();
  await refreshGroups();
  startLiveConnection();
  startIncomingCallListener();
  void registerNativePushToken();
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    void refreshChats();
    void refreshGroups();
    void registerNativePushToken();
  }, 30000);

  if ("serviceWorker" in navigator && window.isSecureContext) {
    try {
      const registration = await navigator.serviceWorker.register("./sw.js");
      await registration.update();
    } catch (error) {
      console.error("Offline website caching could not be set up:", error);
    }
  }

  const targetAccount = new URLSearchParams(location.search).get("chat");
  if (targetAccount && (/^\d{10}$/.test(targetAccount) || targetAccount.includes("@"))) {
    history.replaceState(null, "", location.pathname);
    await openChat(targetAccount);
  }
  const targetGroupId = new URLSearchParams(location.search).get("group");
  if (targetGroupId && /^[0-9a-f-]{36}$/i.test(targetGroupId)) {
    history.replaceState(null, "", location.pathname);
    const group = communities.flatMap((community) => community.groups.map((item) => ({
      ...item,
      communityName: community.name
    }))).find((item) => item.id === targetGroupId);
    if (group) await openGroup(group);
    else showToast("This group is no longer available to your account.");
  }
  const incomingCallId = new URLSearchParams(location.search).get("call");
  if (incomingCallId && /^[0-9a-f-]{36}$/i.test(incomingCallId)) {
    history.replaceState(null, "", location.pathname);
    const { data: call, error } = await db().from("call_sessions")
      .select("id,caller_id,callee_id,media_type,created_at")
      .eq("id", incomingCallId)
      .eq("callee_id", profile.id)
      .maybeSingle();
    if (error) showToast(`Could not load the incoming call: ${error.message}`);
    else if (call) await handleIncomingCall(call);
  }
}

async function handleAuthentication(event) {
  event.preventDefault();
  authError.hidden = true;
  const email = emailInput.value.trim().toLowerCase();
  const phone = phoneInput.value.trim();
  const password = passwordInput.value;
  const name = displayNameInput.value.trim();

  if (authMode === "create") {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      showAuthError("Enter a valid email address.");
      emailInput.focus();
      return;
    }
    if (!/^\d{10}$/.test(phone)) {
      showAuthError("Enter exactly 10 digits for your mobile number.");
      phoneInput.focus();
      return;
    }
  }
  if (password.length < 8) {
    showAuthError("Enter a password with at least 8 characters.");
    passwordInput.focus();
    return;
  }
  if (authMode === "create" && !name) {
    showAuthError("Enter your name to create an account.");
    displayNameInput.focus();
    return;
  }

  authSubmit.disabled = true;
  authSubmit.textContent = authMode === "create" ? "Creating account..." : "Logging in...";
  try {
    if (authMode === "create") {
      const { data, error } = await db().auth.signUp({
        email,
        password,
        options: { data: { name, phone } }
      });
      if (error) throw new Error(error.message);
      if (!data.session) {
        showExistingAccountOptions("Account request submitted. If this is a new email, check your inbox to confirm it. If you already have an account, log in or send a password-reset link.");
        return;
      }
      await showApp(await getMyProfile());
    } else {
      const loginIdentifier = /^\d{10}$/.test(email) ? loginEmail(email) : email;
      const { data, error } = await db().auth.signInWithPassword({
        email: loginIdentifier,
        password
      });
      if (error) throw new Error(error.message);
      if (!data.session) throw new Error("Login did not create a session. Please try again.");
      await showApp(await getMyProfile());
    }
  } catch (error) {
    const message = String(error?.message || error);
    const errorCode = String(error?.code || "").toLowerCase();
    const phoneAlreadyUsed = /profiles_phone_key|phone number.+(already|exists)|phone.+duplicate/i.test(message);
    const emailAlreadyRegistered = /user already registered|email.+(already registered|already exists)|user_already_exists/i.test(`${message} ${errorCode}`);
    if (authMode === "create" && phoneAlreadyUsed) {
      showAuthError("This mobile number is already linked to a Mingle account. Use a different number, or log in with the email already linked to that account.");
    } else if (authMode === "create" && emailAlreadyRegistered) {
      showExistingAccountOptions("This email already has a Mingle account. Log in with its existing password, or send a password-reset link to that email.");
    } else {
      showAuthError(message);
    }
  } finally {
    authSubmit.disabled = false;
    authSubmit.textContent = authMode === "create" ? "Create account" : "Log in";
  }
}

function logInToExistingAccount() {
  const email = emailInput.value.trim().toLowerCase();
  const password = passwordInput.value;
  setAuthMode("login");
  emailInput.value = email;
  passwordInput.value = password;
  passwordInput.focus();
}

async function resetExistingAccountPassword() {
  const email = emailInput.value.trim().toLowerCase();
  setAuthMode("login");
  emailInput.value = email;
  await sendPasswordReset();
}

async function sendPasswordReset() {
  const email = emailInput.value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showAuthError("Enter the email address on your account first. Older accounts must add an email from their profile.");
    emailInput.focus();
    return;
  }

  const button = $("#forgotPasswordButton");
  button.disabled = true;
  try {
    const redirectTo = new URL(location.pathname, location.origin).toString();
    const { error } = await db().auth.resetPasswordForEmail(email, { redirectTo });
    if (error) throw new Error(error.message);
    showAuthError("If this email is registered, Supabase will send a password-reset link. Open it, then use Change password in your profile.");
    authError.classList.remove("error");
    authError.classList.add("success");
  } catch (error) {
    showAuthError(`Could not send the password-reset email: ${error.message}`);
  } finally {
    button.disabled = false;
  }
}

async function changePassword() {
  const password = window.prompt("Enter your new password (at least 8 characters).");
  if (password === null) return;
  if (password.length < 8) {
    showToast("Choose a password with at least 8 characters.");
    return;
  }
  const confirmation = window.prompt("Enter your new password again.");
  if (confirmation === null) return;
  if (confirmation !== password) {
    showToast("The passwords do not match.");
    return;
  }

  try {
    const { error } = await db().auth.updateUser({ password });
    if (error) throw new Error(error.message);
    showToast("Your password has been changed.");
  } catch (error) {
    showToast(`Could not change your password: ${error.message}`);
  }
}

function renderWelcome() {
  const isGroupsPage = page === "groups";
  contentPanel.innerHTML = `<div class="welcome"><div class="welcome-mark" aria-hidden="true">M</div>
    <h2>${isGroupsPage ? "Private groups & communities" : "Your conversations"}</h2>
    <p>${isGroupsPage ? "Create a community, add topic groups, and invite people by their registered Mingle number or email." : "Choose a conversation or find someone using their registered mobile number or email address."}</p></div>`;
}

function composerMarkup() {
  return `<form id="messageForm" class="composer">
      <button id="attachMediaButton" class="composer-icon attach-button" type="button" aria-label="Attach a photo or video" title="Attach a photo or video">
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m8 12.5 6.7-6.7a3 3 0 0 1 4.2 4.2l-8.5 8.5a5 5 0 0 1-7.1-7.1l8.1-8.1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <input id="attachmentInput" class="attachment-input" type="file" accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime">
      <div class="emoji-control">
        <button id="emojiButton" class="composer-icon" type="button" aria-label="Choose emoji" title="Choose emoji">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="8.5" stroke="currentColor" stroke-width="1.8"/><path d="M8.5 14.2s1.2 2 3.5 2 3.5-2 3.5-2M9 9.5h.01M15 9.5h.01" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        </button>
        <div id="emojiPicker" class="emoji-picker" role="group" aria-label="Emoji" hidden>${["😀", "😂", "🥰", "😍", "😊", "😉", "😭", "😎", "👍", "👏", "🙏", "❤️", "🔥", "🎉", "💯", "🤔"].map((emoji) => `<button type="button" aria-label="${emoji}">${emoji}</button>`).join("")}</div>
      </div>
      <span id="attachmentPreview" class="attachment-preview" hidden></span>
      <button id="removeAttachmentButton" class="remove-attachment-button" type="button" aria-label="Remove attachment" hidden>×</button>
      <textarea id="messageInput" maxlength="2000" rows="1" aria-label="Type a message" placeholder="Type a message..."></textarea>
      <button id="voiceMessageButton" class="composer-icon voice-button" type="button" aria-label="Record a voice message" title="Record a voice message">
        <svg class="microphone-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3" stroke="currentColor" stroke-width="1.8"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3m-3 0h6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        <svg class="stop-recording-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>
      </button>
      <button class="send-button" type="submit" aria-label="Send message" title="Send message"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m21 3-7.3 18-3.8-7.9L2 9.3 21 3Z" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="m9.9 13.1 4.5-4.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg></button>
    </form>`;
}

function updateComposerControls() {
  const input = $("#messageInput");
  const file = $("#attachmentInput")?.files?.[0];
  const hasContent = Boolean(input?.value.trim() || file);
  const recording = mediaRecorder?.state === "recording";
  const sendButton = $("#messageForm button[type=submit]");
  const voiceButton = $("#voiceMessageButton");
  if (!sendButton || !voiceButton) return;
  sendButton.hidden = !hasContent || recording;
  voiceButton.hidden = hasContent && !recording;
  voiceButton.classList.toggle("recording", recording);
  voiceButton.setAttribute("aria-label", recording ? "Stop and send voice message" : "Record a voice message");
  voiceButton.title = recording ? "Stop and send voice message" : "Record a voice message";
}

function insertEmoji(emoji) {
  const input = $("#messageInput");
  const start = input.selectionStart;
  const end = input.selectionEnd;
  input.setRangeText(emoji, start, end, "end");
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.focus();
  $("#emojiPicker").hidden = true;
}

function bindComposer() {
  const messageInput = $("#messageInput");
  const attachmentInput = $("#attachmentInput");
  $("#messageForm").addEventListener("submit", sendMessage);
  $("#attachMediaButton").addEventListener("click", () => attachmentInput.click());
  attachmentInput.addEventListener("change", () => {
    const file = attachmentInput.files?.[0];
    if (!file) return;
    const isImage = file.type.startsWith("image/");
    const maximumSize = isImage ? MAX_IMAGE_SIZE : MAX_VIDEO_SIZE;
    if (!isAllowedMediaType(file.type) || file.type.startsWith("audio/") || file.size > maximumSize) {
      attachmentInput.value = "";
      showToast(isAllowedMediaType(file.type) && !file.type.startsWith("audio/")
        ? `${isImage ? "Photos" : "Videos"} must be ${isImage ? "10" : "25"} MB or smaller.`
        : "Choose a JPG, PNG, WebP, GIF, MP4, WebM, or MOV file.");
      updateComposerControls();
      return;
    }
    $("#attachmentPreview").textContent = `${isImage ? "Photo" : "Video"} selected`;
    $("#attachmentPreview").title = file.name;
    $("#attachmentPreview").hidden = false;
    $("#removeAttachmentButton").hidden = false;
    updateComposerControls();
    messageInput.focus();
  });
  $("#removeAttachmentButton").addEventListener("click", () => {
    attachmentInput.value = "";
    $("#attachmentPreview").hidden = true;
    $("#removeAttachmentButton").hidden = true;
    updateComposerControls();
  });
  messageInput.addEventListener("keydown", (keyEvent) => {
    if (keyEvent.key === "Enter" && !keyEvent.shiftKey && !keyEvent.isComposing) {
      keyEvent.preventDefault();
      messageInput.form.requestSubmit();
    }
  });
  messageInput.addEventListener("input", () => {
    messageInput.style.height = "auto";
    messageInput.style.height = `${Math.min(messageInput.scrollHeight, 72)}px`;
    updateComposerControls();
  });
  $("#emojiButton").addEventListener("click", () => {
    $("#emojiPicker").hidden = !$("#emojiPicker").hidden;
  });
  $("#emojiPicker").addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (button) insertEmoji(button.textContent);
  });
  $("#voiceMessageButton").addEventListener("click", () => {
    if (mediaRecorder?.state === "recording") stopVoiceRecording(false);
    else void startVoiceRecording();
  });
  updateComposerControls();
}

async function startVoiceRecording() {
  if (recordingStarting) return;
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    showToast("Voice recording needs a secure HTTPS site and a browser that supports microphone recording.");
    return;
  }
  const target = currentConversationTarget();
  if (!target) return;

  recordingStarting = true;
  try {
    recordingStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recordingStarting = false;
    if (!isCurrentConversation(target)) {
      recordingStream.getTracks().forEach((track) => track.stop());
      recordingStream = null;
      return;
    }
    recordingTarget = target;
    recordedChunks = [];
    const supportedTypes = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"];
    const mimeType = supportedTypes.find((type) => MediaRecorder.isTypeSupported(type));
    mediaRecorder = mimeType ? new MediaRecorder(recordingStream, { mimeType }) : new MediaRecorder(recordingStream);
    mediaRecorder.addEventListener("dataavailable", (event) => {
      if (event.data.size) recordedChunks.push(event.data);
    });
    mediaRecorder.addEventListener("error", (event) => {
      showToast(`Could not record voice message: ${event.error?.message || "microphone recording failed."}`);
    });
    mediaRecorder.addEventListener("stop", () => {
      const activeRecorder = mediaRecorder;
      const target = recordingTarget;
      const chunks = recordedChunks;
      const type = activeRecorder?.mimeType.split(";")[0] || chunks[0]?.type.split(";")[0] || "";
      mediaRecorder = null;
      recordingTarget = null;
      recordedChunks = [];
      clearTimeout(recordingTimer);
      recordingStream?.getTracks().forEach((track) => track.stop());
      recordingStream = null;
      updateComposerControls();

      const blob = new Blob(chunks, { type });
      if (!blob.size) {
        showToast("No voice audio was recorded. Please try again.");
      } else if (blob.size > MAX_VOICE_SIZE) {
        showToast("Voice messages must be 25 MB or smaller.");
      } else if (!isAllowedMediaType(type)) {
        showToast("This browser recorded an unsupported audio format. Try another browser.");
      } else if (target && isCurrentConversation(target)) {
        const voiceFile = new File([blob], `voice-${Date.now()}.${mediaExtension(type)}`, { type });
        void sendPreparedMessage(voiceFile, target);
      } else if (target) {
        showToast("Voice message was not sent because you left that conversation.");
      }
    }, { once: true });
    mediaRecorder.start();
    updateComposerControls();
    recordingTimer = setTimeout(() => stopVoiceRecording(false), 120000);
  } catch (error) {
    recordingStarting = false;
    recordingStream?.getTracks().forEach((track) => track.stop());
    recordingStream = null;
    mediaRecorder = null;
    updateComposerControls();
    showToast(`Could not start voice recording: ${error.message}`);
  }
}

function stopVoiceRecording(cancel) {
  if (!mediaRecorder || mediaRecorder.state === "inactive") return;
  if (cancel) recordingTarget = null;
  clearTimeout(recordingTimer);
  mediaRecorder.stop();
}

async function openChat(identifier) {
  if (messageTimer) clearInterval(messageTimer);
  if (mediaRecorder?.state === "recording") stopVoiceRecording(true);
  try {
    const peer = await findProfile(identifier);
    if (!await unlockChat(peer.id)) return;
    currentPeer = peer;
    currentGroup = null;
    page = "chats";
    updateNav("chats");
    const { data: archive, error: archiveError } = await db()
      .from("chat_archives")
      .select("peer_id")
      .eq("user_id", profile.id)
      .eq("peer_id", peer.id)
      .maybeSingle();
    if (archiveError) throw new Error(archiveError.message);
    currentPeerArchived = Boolean(archive);
    await refreshChats();
    $("#newChatButton").hidden = false;
    messenger.classList.remove("show-page");
    messenger.classList.add("show-chat");
    contentPanel.innerHTML = `<header class="conversation-header">
        <button id="backButton" class="icon-button back-button" type="button" aria-label="Back to messages"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m14.5 5-7 7 7 7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
        <button id="peerProfileButton" class="person profile-trigger" type="button" aria-label="View ${escapeText(peer.name)}'s profile">
          <span class="avatar">${escapeText(initials(peer.name))}</span><span><span class="person-name">${escapeText(peer.name)}</span><span class="person-summary">${escapeText(peer.phone)} · View profile</span></span>
        </button><div class="conversation-actions">
          <button id="videoCallButton" class="call-icon-button" type="button" aria-label="Start video call" title="Video call"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3" y="6" width="12" height="12" rx="2" stroke="currentColor" stroke-width="1.8"/><path d="m15 10 6-3v10l-6-3" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg></button>
          <button id="audioCallButton" class="call-icon-button" type="button" aria-label="Start voice call" title="Voice call"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7.2 3.8 9.5 7.5 8 9.1a14 14 0 0 0 6.9 6.9l1.6-1.5 3.7 2.3-.6 3.1a2 2 0 0 1-2.2 1.6A17.5 17.5 0 0 1 2.5 6.6a2 2 0 0 1 1.6-2.2z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg></button>
          <button id="messageSearchButton" class="call-icon-button" type="button" aria-label="Search messages" title="Search messages"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.8" stroke="currentColor" stroke-width="1.8"/><path d="m16 16 4 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button>
          <div class="conversation-menu-wrap">
            <button id="conversationMenuButton" class="call-icon-button" type="button" aria-label="More chat options" title="More options" aria-haspopup="menu" aria-expanded="false"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="19" r="1.7"/></svg></button>
            <div id="conversationMenu" class="conversation-menu" role="menu" hidden>
              <button id="archiveChatButton" type="button" role="menuitem">${currentPeerArchived ? "Unarchive chat" : "Archive chat"}</button>
              <button id="lockChatButton" type="button" role="menuitem">${getLockedPeerIds().has(peer.id) ? "Unlock chat" : "Lock chat"}</button>
            </div>
          </div>
        </div>
      </header>
      <label class="conversation-search" id="conversationSearchWrap" hidden>
        <span class="visually-hidden">Search messages in this chat</span>
        <input id="messageSearchInput" type="search" placeholder="Search messages" autocomplete="off">
        <button id="closeMessageSearchButton" type="button" aria-label="Close message search">×</button>
      </label>
      <div class="messages" id="messageList" role="log" aria-label="Messages with ${escapeText(peer.name)}"></div>
      ${composerMarkup()}`;
    $("#backButton").addEventListener("click", () => {
      clearInterval(messageTimer);
      currentPeer = null;
      currentGroup = null;
      currentPeerArchived = false;
      messenger.classList.remove("show-chat");
      void refreshChats();
      renderWelcome();
    });
    $("#peerProfileButton").addEventListener("click", () => renderProfile(peer));
    $("#videoCallButton").addEventListener("click", () => void startCall("video", peer));
    $("#audioCallButton").addEventListener("click", () => void startCall("audio", peer));
    $("#messageSearchButton").addEventListener("click", () => {
      const searchWrap = $("#conversationSearchWrap");
      searchWrap.hidden = false;
      $("#messageSearchInput").focus();
    });
    $("#messageSearchInput").addEventListener("input", (event) => filterConversationMessages(event.currentTarget.value));
    $("#closeMessageSearchButton").addEventListener("click", () => {
      $("#messageSearchInput").value = "";
      filterConversationMessages("");
      $("#conversationSearchWrap").hidden = true;
    });
    $("#conversationMenuButton").addEventListener("click", () => {
      const menu = $("#conversationMenu");
      const opening = menu.hidden;
      menu.hidden = !opening;
      $("#conversationMenuButton").setAttribute("aria-expanded", String(opening));
    });
    $("#archiveChatButton").addEventListener("click", () => {
      closeConversationMenu();
      void setChatArchived(peer.id, !currentPeerArchived);
    });
    $("#lockChatButton").addEventListener("click", () => {
      closeConversationMenu();
      void toggleChatLock(peer);
    });
    const messageInput = $("#messageInput");
    bindComposer();
    await loadMessages();
    messageTimer = setInterval(() => void loadMessages(), 15000);
    messageInput.focus();
  } catch (error) {
    showToast(error.message);
  }
}

async function openGroup(group) {
  if (messageTimer) clearInterval(messageTimer);
  if (mediaRecorder?.state === "recording") stopVoiceRecording(true);
  currentPeer = null;
  currentGroup = group;
  page = "groups";
  updateNav("groups");
  messenger.classList.remove("show-page");
  messenger.classList.add("show-chat");
  contentPanel.innerHTML = `<header class="conversation-header">
      <button id="backButton" class="icon-button back-button" type="button" aria-label="Back to groups"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m14.5 5-7 7 7 7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      <span class="avatar">${escapeText(initials(group.name))}</span>
      <span class="person"><span><span class="person-name">${escapeText(group.name)}</span><span class="person-summary">${escapeText(group.communityName)} · Private group</span></span></span>
    </header>
    <div class="messages" id="messageList" role="log" aria-label="Messages in ${escapeText(group.name)}"></div>
    ${composerMarkup()}`;
  $("#backButton").addEventListener("click", () => {
    if (mediaRecorder?.state === "recording") stopVoiceRecording(true);
    clearInterval(messageTimer);
    currentGroup = null;
    messenger.classList.remove("show-chat");
    renderWelcome();
    void refreshGroups();
  });
  bindComposer();
  await loadMessages();
  messageTimer = setInterval(() => void loadMessages(), 15000);
  $("#messageInput").focus();
}

async function loadMessages() {
  const peer = currentPeer;
  const group = currentGroup;
  if (!peer && !group) return;
  const target = group
    ? { kind: "group", id: group.id }
    : { kind: "direct", id: peer.id };
  try {
    let data;
    let error;
    if (group) {
      ({ data, error } = await db().rpc("get_group_messages", { p_group_id: group.id }));
    } else {
      ({ data, error } = await db()
        .from("messages")
        .select("id,sender_id,recipient_id,text,created_at,read_at,updated_at,deleted_at,attachment_path,attachment_name,attachment_mime,attachment_size")
        .or(`and(sender_id.eq.${profile.id},recipient_id.eq.${peer.id}),and(sender_id.eq.${peer.id},recipient_id.eq.${profile.id})`)
        .order("created_at", { ascending: true })
        .limit(500));
    }
    if (error) throw new Error(error.message);
    const messages = (data || []).map(mapMessage);
    if (!isCurrentConversation(target)) return;
    if (peer) {
      const { error: readError } = await db()
        .from("messages")
        .update({ read_at: new Date().toISOString() })
        .eq("sender_id", peer.id)
        .eq("recipient_id", profile.id)
        .is("read_at", null);
      if (readError) throw new Error(readError.message);
      if (!isCurrentConversation(target)) return;
    }
    const messageList = $("#messageList");
    if (!messageList) return;
    const wasNearBottom = messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight < 120;
    messageList.replaceChildren();
    if (!messages.length) {
      const empty = document.createElement("div");
      empty.className = "empty-list";
      empty.textContent = group
        ? `This is the start of ${group.name}. Send a message to the community group.`
        : `You are now connected with ${peer.name}. Send a message to say hello.`;
      messageList.append(empty);
    }
    for (const message of messages) {
      const bubble = document.createElement("article");
      bubble.className = `message${message.senderId === profile.id ? " mine" : ""}`;
      if (group && message.senderId !== profile.id && message.senderName) {
        const senderName = document.createElement("div");
        senderName.className = "group-sender-name";
        senderName.textContent = message.senderName;
        bubble.append(senderName);
      }
      if (message.text || message.deletedAt) {
        const text = document.createElement("div");
        text.className = message.deletedAt ? "deleted-message" : "";
        text.textContent = message.deletedAt ? "This message was deleted." : message.text;
        bubble.append(text);
      }
      if (message.attachmentPath && !message.deletedAt) {
        await appendMessageAttachment(message, bubble);
        if (!isCurrentConversation(target)) return;
      }
      const time = document.createElement("div");
      time.className = "message-meta";
      const edited = message.updatedAt ? " · Edited" : "";
      time.textContent = `${timeLabel(message.createdAt)}${edited}${message.readAt ? " · Read" : ""}`;
      bubble.append(time);
      if (message.senderId === profile.id && !message.deletedAt) {
        const actions = document.createElement("div");
        actions.className = "message-actions";
        if (message.text && Date.now() - new Date(message.createdAt).getTime() <= 15 * 60 * 1000) {
          const editButton = document.createElement("button");
          editButton.type = "button";
          editButton.textContent = "Edit";
          editButton.addEventListener("click", () => void editMessage(message));
          actions.append(editButton);
        }
        const deleteButton = document.createElement("button");
        deleteButton.type = "button";
        deleteButton.textContent = "Delete for everyone";
        deleteButton.addEventListener("click", () => void deleteMessage(message));
        actions.append(deleteButton);
        bubble.append(actions);
      }
      messageList.append(bubble);
    }
    filterConversationMessages($("#messageSearchInput")?.value || "");
    if (wasNearBottom || messages.length <= 1) messageList.scrollTop = messageList.scrollHeight;
    lastMessageLoadError = null;
    if (peer) void refreshChats();
  } catch (error) {
    console.error("Could not load messages:", error);
    if (lastMessageLoadError !== error.message) showToast(`Could not load messages: ${error.message}`);
    lastMessageLoadError = error.message;
  }
}

async function editMessage(message) {
  const updatedText = window.prompt("Edit your message (within 15 minutes).", message.text);
  if (updatedText === null || !updatedText.trim()) return;

  try {
    const { error } = await db().rpc(message.groupId ? "edit_group_message" : "edit_message", {
      p_message_id: message.id,
      p_text: updatedText.trim()
    });
    if (error) throw new Error(error.message);
    await loadMessages();
  } catch (error) {
    showToast(`Could not edit message: ${error.message}`);
  }
}

async function deleteMessage(message) {
  if (!window.confirm("Delete this message for everyone in the chat?")) return;

  try {
    const { error } = await db().rpc(message.groupId ? "delete_group_message" : "delete_message", { p_message_id: message.id });
    if (error) throw new Error(error.message);
    if (message.attachmentPath) {
      signedMediaUrls.delete(message.attachmentPath);
      const { error: storageError } = await db().storage.from(MEDIA_BUCKET).remove([message.attachmentPath]);
      if (storageError) {
        showToast(`Message deleted, but its stored attachment could not be removed: ${storageError.message}`);
        await loadMessages();
        return;
      }
    }
    await loadMessages();
  } catch (error) {
    showToast(`Could not delete message: ${error.message}`);
  }
}

async function sendMessage(event) {
  event.preventDefault();
  await sendPreparedMessage($("#attachmentInput").files?.[0] || null, currentConversationTarget());
}

async function sendPreparedMessage(file, target) {
  const input = $("#messageInput");
  const text = input?.value.trim() || "";
  if (!target || (!text && !file)) return;
  const button = $("#messageForm button[type=submit]");
  const attachmentPath = file
    ? `${profile.id}/${target.id}/${crypto.randomUUID()}.${mediaExtension(file.type)}`
    : null;
  let uploaded = false;
  let sent = false;
  if (button) button.disabled = true;
  try {
    if (file) {
      if (!isAllowedMediaType(file.type)) throw new Error("Choose a supported photo or video file.");
      const maximumSize = file.type.startsWith("image/") ? MAX_IMAGE_SIZE : file.type.startsWith("audio/") ? MAX_VOICE_SIZE : MAX_VIDEO_SIZE;
      if (file.size > maximumSize) {
        throw new Error(file.type.startsWith("image/")
          ? "Photos must be 10 MB or smaller."
          : file.type.startsWith("audio/") ? "Voice messages must be 25 MB or smaller." : "Videos must be 25 MB or smaller.");
      }
      const { error: uploadError } = await db().storage.from(MEDIA_BUCKET).upload(attachmentPath, file, {
        contentType: file.type,
        upsert: false
      });
      if (uploadError) throw new Error(`Could not upload attachment: ${uploadError.message}`);
      uploaded = true;
    }

    const payload = {
      sender_id: profile.id,
      text: text || null,
      attachment_path: attachmentPath,
      attachment_name: file?.name || null,
      attachment_mime: file?.type || null,
      attachment_size: file?.size || null
    };
    const { data: sentMessage, error } = target.kind === "group"
      ? await db().from("group_messages").insert({ ...payload, group_id: target.id })
        .select("id").single()
      : await db().from("messages").insert({ ...payload, recipient_id: target.id })
        .select("id").single();
    if (error) throw new Error(error.message);
    sent = true;
    if (sentMessage?.id) {
      void sendPushEvent({
        kind: target.kind === "group" ? "group-message" : "message",
        messageId: sentMessage.id
      });
    }
    if (input) {
      input.value = "";
      input.style.height = "auto";
    }
    const attachmentInput = $("#attachmentInput");
    if (attachmentInput) attachmentInput.value = "";
    if ($("#attachmentPreview")) $("#attachmentPreview").hidden = true;
    if ($("#removeAttachmentButton")) $("#removeAttachmentButton").hidden = true;
    updateComposerControls();
    input?.focus();
    await Promise.all([loadMessages(), target.kind === "group" ? refreshGroups() : refreshChats()]);
  } catch (error) {
    if (uploaded && !sent && attachmentPath) {
      const { error: cleanupError } = await db().storage.from(MEDIA_BUCKET).remove([attachmentPath]);
      if (cleanupError) {
        showToast(`${error.message}. Uploaded media cleanup also failed: ${cleanupError.message}`);
        return;
      }
    }
    showToast(error.message);
  } finally {
    if (button?.isConnected) button.disabled = false;
  }
}

function renderProfile(person = profile) {
  if (!person) return;
  clearInterval(messageTimer);
  const profileReturnPage = page.startsWith("settings") ? "settings" : "chats";
  if (person.id === profile.id) page = "profile";
  else page = "contact-profile";
  updateNav(person.id === profile.id ? profileReturnPage : "chats");
  if (person.id === profile.id) {
    if (mediaRecorder?.state === "recording") stopVoiceRecording(true);
    currentPeer = null;
    currentGroup = null;
    messenger.classList.remove("show-chat");
    messenger.classList.add("show-page");
    $("#listTitle").textContent = "Your profile";
    $("#searchInput").parentElement.hidden = true;
    $("#newChatButton").hidden = true;
  }
  const isMe = person.id === profile.id;
  const ownFields = isMe
    ? `<div class="profile-section"><div class="profile-label">Privacy</div>
        <p class="content-description">Your exact mobile number and email are shown to people who search for either one. Chat locks are stored on this device only and do not encrypt messages on the server.</p></div>
       <button id="profileSettingsButton" class="notification-button" type="button">Open Settings</button>
       <button id="changePasswordButton" class="notification-button" type="button">Change password</button>
       <button id="logoutButton" class="danger-button" type="button">Log out</button>`
    : `<button id="messageThisPerson" class="primary message-profile-button" type="button">Send a message</button>`;
  contentPanel.innerHTML = `<header class="conversation-header">
      <button id="profileBackButton" class="icon-button back-button" type="button" aria-label="Back to messages"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m14.5 5-7 7 7 7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      <span class="person-name">${isMe ? "Your profile" : "Contact profile"}</span>
    </header>
    <section class="profile-content"><h2>${isMe ? "Your account" : "Contact details"}</h2>
      <p class="content-description">${isMe ? "Your account details are saved in the Mingle database." : "This person was found using a registered mobile number or email address."}</p>
      <div class="profile-card"><span class="avatar">${escapeText(initials(person.name))}</span>
        <div><div class="profile-name">${escapeText(person.name)}</div><div class="profile-detail">Member since ${escapeText(new Date(person.createdAt).toLocaleDateString())}</div></div></div>
      <div class="profile-label">Mobile number</div><div class="profile-value">${escapeText(person.phone)}</div>
      <div class="profile-label">Email</div><div class="profile-value">${escapeText(person.email || "Not set for this older account")}</div>
      ${isMe && !person.email ? `<button id="addLoginEmailButton" class="notification-button" type="button">Add email for login and password recovery</button>` : ""}
      ${ownFields}
    </section>`;
  $("#profileBackButton").addEventListener("click", () => {
    if (isMe && profileReturnPage === "settings") openSettingsPage();
    else if (isMe) openChatsPage();
    else void openChat(person.phone);
  });
  if (isMe) {
    if (!person.email) $("#addLoginEmailButton").addEventListener("click", () => void addLoginEmail());
    $("#profileSettingsButton").addEventListener("click", openSettingsPage);
    $("#changePasswordButton").addEventListener("click", () => void changePassword());
    $("#logoutButton").addEventListener("click", async () => {
      try {
        const { error } = await db().auth.signOut();
        if (error) throw new Error(error.message);
        showLogin();
      } catch (error) {
        showToast(error.message);
      }
    });
  } else {
    $("#messageThisPerson").addEventListener("click", () => void openChat(person.phone));
  }
}

function filterConversationMessages(value) {
  const messageList = $("#messageList");
  if (!messageList) return;
  const query = value.trim().toLocaleLowerCase();
  let matches = 0;
  for (const emptyState of messageList.querySelectorAll(".empty-list:not(#messageSearchEmpty)")) {
    emptyState.hidden = Boolean(query);
  }
  for (const message of messageList.querySelectorAll(".message")) {
    const visible = !query || message.textContent.toLocaleLowerCase().includes(query);
    message.hidden = !visible;
    if (visible) matches += 1;
  }
  messageList.querySelector("#messageSearchEmpty")?.remove();
  if (query && !matches) {
    const empty = document.createElement("div");
    empty.id = "messageSearchEmpty";
    empty.className = "empty-list";
    empty.textContent = "No messages match your search.";
    messageList.append(empty);
  }
}

function closeConversationMenu() {
  const menu = $("#conversationMenu");
  const button = $("#conversationMenuButton");
  if (!menu || !button) return;
  menu.hidden = true;
  button.setAttribute("aria-expanded", "false");
}

function openSettingsPage() {
  if (mediaRecorder?.state === "recording") stopVoiceRecording(true);
  page = "settings";
  currentPeer = null;
  currentGroup = null;
  currentPeerArchived = false;
  clearInterval(messageTimer);
  messenger.classList.remove("show-chat");
  messenger.classList.add("show-page");
  $("#listTitle").textContent = "Settings";
  $("#searchInput").parentElement.hidden = true;
  $("#newChatButton").hidden = true;
  $("#archiveViewButton").hidden = true;
  updateNav("settings");
  renderSettings();
}

function renderSettings() {
  contentPanel.innerHTML = `<header class="conversation-header"><span class="person-name">Settings</span></header>
    <section class="settings-content" aria-label="Settings">
      <div class="settings-account-card"><span class="avatar">${escapeText(initials(profile.name))}</span>
        <div><div class="profile-name">${escapeText(profile.name)}</div><div class="profile-detail">${escapeText(profile.email || profile.phone)}</div></div>
        <button id="settingsAccountButton" class="secondary" type="button">View</button></div>
      <div class="settings-list">${settingsSections.map((section) => `<button class="settings-row" type="button" data-settings-section="${section.id}">
        <span class="settings-icon" aria-hidden="true">${section.icon}</span><span class="settings-row-copy"><strong>${section.title}</strong><small>${section.description}</small></span><span class="settings-chevron" aria-hidden="true">›</span>
      </button>`).join("")}</div>
    </section>`;
  $("#settingsAccountButton").addEventListener("click", () => renderProfile(profile));
  contentPanel.querySelectorAll("[data-settings-section]").forEach((button) => {
    button.addEventListener("click", () => {
      const { settingsSection } = button.dataset;
      if (settingsSection === "account") renderProfile(profile);
      else if (settingsSection === "invite") void inviteFriend();
      else renderSettingsSection(settingsSection);
    });
  });
}

function renderSettingsSection(section) {
  page = `settings-${section}`;
  const labels = {
    privacy: "Privacy",
    chats: "Chats",
    notifications: "Notifications",
    storage: "Storage and data",
    help: "Help"
  };
  const heading = labels[section];
  if (!heading) {
    openSettingsPage();
    return;
  }
  const body = section === "privacy"
    ? `<div class="settings-info-card"><strong>Who can find you</strong><p>Mingle users can find your account using your registered mobile number or email. These lookup options are required to start a chat.</p></div>
       <div class="settings-info-card"><strong>Chat lock</strong><p>A chat lock is saved only on this device. It is a convenience lock, not end-to-end encryption, and does not protect messages on the server.</p></div>
       <div class="settings-info-card"><strong>Message security</strong><p>Mingle messages are stored in your Supabase project and are not end-to-end encrypted. Do not send information you need to keep private from the project owner.</p></div>`
    : section === "chats"
      ? `<div class="settings-option-group"><h3>Theme</h3><div class="settings-choice-row">
          <button class="settings-choice" type="button" data-theme-choice="light">Light</button><button class="settings-choice" type="button" data-theme-choice="dark">Dark</button>
        </div><p class="settings-help">Theme is saved on this device.</p></div>
        <div class="settings-option-group"><h3>Chat wallpaper</h3><div class="wallpaper-choices" role="group" aria-label="Chat wallpaper">
          <button class="wallpaper-choice" type="button" data-wallpaper-choice="default" aria-label="Default wallpaper"><span></span><small>Default</small></button>
          <button class="wallpaper-choice" type="button" data-wallpaper-choice="mint" aria-label="Mint wallpaper"><span></span><small>Mint</small></button>
          <button class="wallpaper-choice" type="button" data-wallpaper-choice="sky" aria-label="Sky wallpaper"><span></span><small>Sky</small></button>
          <button class="wallpaper-choice" type="button" data-wallpaper-choice="lavender" aria-label="Lavender wallpaper"><span></span><small>Lavender</small></button>
        </div><p class="settings-help">Wallpaper is applied to message conversations on this device.</p></div>`
      : section === "notifications"
        ? `<div class="settings-info-card"><strong>Message notifications</strong><p id="notificationStatus">${notificationStatusText()}</p><button id="notificationButton" class="notification-button" type="button">${notificationButtonText()}</button></div>
           <div class="settings-info-card"><strong>Background delivery</strong><p>Website push works only after the site owner configures push credentials. Android APK notifications also require Firebase Cloud Messaging setup. If the phone is powered off, notifications and calls cannot arrive.</p></div>
           <label class="settings-toggle"><span><strong>Message sound</strong><small>Use the device notification sound when available</small></span><input id="messageSoundToggle" type="checkbox" checked></label>
           <label class="settings-toggle"><span><strong>Incoming call ringtone</strong><small>Play the Mingle ringtone while the app is open</small></span><input id="callRingtoneToggle" type="checkbox" checked></label>`
        : section === "storage"
          ? `<div class="settings-info-card"><strong>Website data on this device</strong><p id="storageUsage">Checking this device's website storage…</p></div>
             <div class="settings-info-card"><strong>Chat media</strong><p>Photos and videos are stored in your private Supabase project. Photos can be up to 10 MB; videos and voice notes up to 25 MB. Supabase Free has storage and bandwidth limits.</p></div>`
          : `<div class="settings-info-card"><strong>Mingle help</strong><p>For account or setup issues, contact the person who manages your Mingle website and Supabase project.</p></div>
             <div class="settings-info-card"><strong>About Mingle</strong><p>Mingle is a community chat website. It is not affiliated with WhatsApp.</p></div>`;

  contentPanel.innerHTML = `<header class="conversation-header">
      <button id="settingsBackButton" class="icon-button back-button settings-back" type="button" aria-label="Back to settings"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m14.5 5-7 7 7 7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      <span class="person-name">${heading}</span>
    </header><section class="settings-content" aria-label="${heading} settings">${body}</section>`;
  $("#settingsBackButton").addEventListener("click", openSettingsPage);
  if (section === "chats") {
    contentPanel.querySelectorAll("[data-theme-choice]").forEach((button) => {
      const selected = button.dataset.themeChoice === getPreference("mingle-theme", "light");
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-pressed", String(selected));
      button.addEventListener("click", () => {
        setPreference("mingle-theme", button.dataset.themeChoice);
        applyPreferences();
        renderSettingsSection("chats");
      });
    });
    contentPanel.querySelectorAll("[data-wallpaper-choice]").forEach((button) => {
      const selected = button.dataset.wallpaperChoice === getPreference("mingle-wallpaper", "default");
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-pressed", String(selected));
      button.addEventListener("click", () => {
        setPreference("mingle-wallpaper", button.dataset.wallpaperChoice);
        applyPreferences();
        renderSettingsSection("chats");
      });
    });
  } else if (section === "notifications") {
    const soundToggle = $("#messageSoundToggle");
    soundToggle.checked = getPreference("mingle-message-sound", "on") !== "off";
    soundToggle.addEventListener("change", () => setPreference("mingle-message-sound", soundToggle.checked ? "on" : "off"));
    const ringtoneToggle = $("#callRingtoneToggle");
    ringtoneToggle.checked = getPreference("mingle-call-ringtone", "on") !== "off";
    ringtoneToggle.addEventListener("change", () => setPreference("mingle-call-ringtone", ringtoneToggle.checked ? "on" : "off"));
    $("#notificationButton").disabled = !window.MingleAndroid && "Notification" in window && Notification.permission === "granted";
    $("#notificationButton").addEventListener("click", () => void enableNotifications());
  } else if (section === "storage") {
    void updateStorageUsage();
  }
}

function getPreference(key, fallback) {
  return localStorage.getItem(key) || fallback;
}

function setPreference(key, value) {
  localStorage.setItem(key, value);
}

function applyPreferences() {
  document.documentElement.dataset.theme = getPreference("mingle-theme", "light");
  const wallpapers = {
    default: document.documentElement.dataset.theme === "dark" ? "#18211b" : "#fbfcfa",
    mint: "#eef8f0",
    sky: "#eef6fc",
    lavender: "#f4f0fa"
  };
  document.documentElement.style.setProperty("--chat-wallpaper", wallpapers[getPreference("mingle-wallpaper", "default")] || wallpapers.default);
}

function notificationStatusText() {
  if (window.MingleAndroid) return "Android push notifications need Firebase configuration and permission on this device.";
  if (!("Notification" in window)) return "Notifications are not supported in this browser.";
  if (!window.isSecureContext) return "Open Mingle over HTTPS to enable notifications.";
  if (Notification.permission === "granted") {
    return WEB_PUSH_PUBLIC_KEY
      ? "Notifications are allowed. Background push can be enabled on this browser."
      : "Notifications are allowed while Mingle is open. Background push is not configured yet.";
  }
  if (Notification.permission === "denied") return "Notifications are blocked. Change this site's permission in your browser settings.";
  return "Notifications have not been enabled on this device.";
}

function notificationButtonText() {
  if (!("Notification" in window) || !window.isSecureContext) return "Notifications unavailable";
  return Notification.permission === "granted" ? "Notifications enabled" : "Enable notifications";
}

async function updateStorageUsage() {
  const output = $("#storageUsage");
  if (!output) return;
  if (!navigator.storage?.estimate) {
    output.textContent = "This browser does not provide a local storage estimate.";
    return;
  }
  try {
    const { usage, quota } = await navigator.storage.estimate();
    if (!output.isConnected) return;
    output.textContent = usage === undefined
      ? "The browser did not report a storage estimate."
      : `${formatBytes(usage)} used on this device${quota ? ` of ${formatBytes(quota)} available to this site` : ""}. This does not include your Supabase chat media.`;
  } catch (error) {
    output.textContent = `Could not read device storage: ${error.message}`;
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

async function inviteFriend() {
  const inviteUrl = new URL(location.pathname, location.origin).toString();
  const invite = { title: "Mingle Chat", text: "Join me on Mingle Chat", url: inviteUrl };
  try {
    if (navigator.share) {
      await navigator.share(invite);
    } else if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(inviteUrl);
      showToast("Mingle link copied. Share it with your friend.");
    } else {
      window.prompt("Copy and share this Mingle link:", inviteUrl);
    }
  } catch (error) {
    if (error.name !== "AbortError") showToast(`Could not share the Mingle link: ${error.message}`);
  }
}

async function addLoginEmail() {
  const email = window.prompt("Enter the email address you want to use to log in.");
  if (email === null) return;
  const normalizedEmail = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    showToast("Enter a valid email address.");
    return;
  }

  try {
    const { error } = await db().auth.updateUser({
      email: normalizedEmail,
      data: { name: profile.name, phone: profile.phone }
    });
    if (error) throw new Error(error.message);
    profile = await getMyProfile();
    showToast(profile.email
      ? "Your email is now saved for login and password recovery."
      : "Email update requested. Complete any confirmation Supabase sends, then log in with the new email.");
    renderProfile(profile);
  } catch (error) {
    showToast(`Could not add your login email: ${error.message}`);
  }
}

function openChatsPage() {
  if (mediaRecorder?.state === "recording") stopVoiceRecording(true);
  page = "chats";
  archivedView = false;
  currentPeer = null;
  currentGroup = null;
  currentPeerArchived = false;
  clearInterval(messageTimer);
  messenger.classList.remove("show-chat", "show-page");
  $("#listTitle").textContent = "Messages";
  $("#searchInput").parentElement.hidden = false;
  $("#newChatButton").hidden = false;
  $("#archiveViewButton").hidden = false;
  updateNav("chats");
  void refreshChats();
  renderWelcome();
}

function openGroupsPage() {
  if (mediaRecorder?.state === "recording") stopVoiceRecording(true);
  page = "groups";
  archivedView = false;
  currentPeer = null;
  currentGroup = null;
  currentPeerArchived = false;
  clearInterval(messageTimer);
  messenger.classList.remove("show-chat", "show-page");
  $("#listTitle").textContent = "Groups & communities";
  $("#searchInput").parentElement.hidden = false;
  $("#archiveViewButton").hidden = true;
  $("#newChatButton").hidden = false;
  updateNav("groups");
  renderWelcome();
  void refreshGroups();
}

async function findContact(event) {
  event.preventDefault();
  const identifier = identifierInput.value.trim();
  const normalizedIdentifier = normalizeContactIdentifier(identifier);
  const isPhone = /^\d{10}$/.test(normalizedIdentifier);
  const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedIdentifier);
  if (!isPhone && !isEmail) {
    dialogError.textContent = "Enter the 10-digit mobile number without a country code, or a valid email address.";
    dialogError.hidden = false;
    return;
  }
  $("#startChatSubmit").disabled = true;
  try {
    const person = await findProfile(normalizedIdentifier);
    dialog.close();
    identifierInput.value = "";
    dialogError.hidden = true;
    renderProfile(person);
  } catch (error) {
    dialogError.textContent = error.message;
    dialogError.hidden = false;
  } finally {
    $("#startChatSubmit").disabled = false;
  }
}

async function enableNotifications() {
  const button = $("#notificationButton");
  if (window.MingleAndroid?.RequestNotificationPermission) {
    window.MingleAndroid.RequestNotificationPermission();
    await registerNativePushToken();
  }
  if (!("Notification" in window)) {
    button.textContent = window.MingleAndroid
      ? "Android notification permission requested"
      : "Notifications are not supported in this browser";
    return;
  }
  if (!window.isSecureContext) {
    button.textContent = "Open this site using HTTPS to enable notifications";
    return;
  }
  button.disabled = true;
  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      button.textContent = "Allow notifications in your browser settings";
      return;
    }
    if (WEB_PUSH_PUBLIC_KEY && "serviceWorker" in navigator && "PushManager" in window) {
      const registration = await navigator.serviceWorker.ready;
      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: decodeBase64Url(WEB_PUSH_PUBLIC_KEY)
        });
      }
      const subscriptionJson = subscription.toJSON();
      const { error } = await db().from("push_subscriptions").upsert({
        user_id: profile.id,
        endpoint: subscription.endpoint,
        platform: "web",
        p256dh: subscriptionJson.keys?.p256dh,
        auth: subscriptionJson.keys?.auth,
        updated_at: new Date().toISOString()
      }, { onConflict: "user_id,endpoint" });
      if (error) throw new Error(error.message);
      button.textContent = "Background notifications enabled";
      showToast("Notifications enabled on this browser. Your device may still suppress alerts through its system settings.");
    } else {
      button.textContent = "Notifications enabled while Mingle is open";
      showToast("Permission is enabled. Background notifications need the site owner to finish push setup.");
    }
    const status = $("#notificationStatus");
    if (status) status.textContent = notificationStatusText();
  } catch (error) {
    button.textContent = `Could not enable notifications: ${error.message}`;
    showToast(`Could not enable notifications: ${error.message}`);
  } finally {
    button.disabled = false;
  }
}

async function registerNativePushToken() {
  if (!profile || !window.MingleAndroid?.GetFcmToken) return;
  try {
    const token = window.MingleAndroid.GetFcmToken();
    if (!token) return;
    const { error } = await db().from("push_subscriptions").upsert({
      user_id: profile.id,
      endpoint: token,
      platform: "fcm",
      p256dh: null,
      auth: null,
      updated_at: new Date().toISOString()
    }, { onConflict: "user_id,endpoint" });
    if (error) throw new Error(error.message);
  } catch (error) {
    console.error("Could not register Android push notifications:", error);
    showToast(`Could not register Android notifications: ${error.message}`);
  }
}

function decodeBase64Url(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

async function initialize() {
  $("#loginTab").addEventListener("click", () => setAuthMode("login"));
  $("#createTab").addEventListener("click", () => setAuthMode("create"));
  authForm.addEventListener("submit", handleAuthentication);
  phoneInput.addEventListener("input", () => { phoneInput.value = phoneInput.value.replace(/\D/g, "").slice(0, 10); });
  emailInput.addEventListener("blur", () => { emailInput.value = emailInput.value.trim().toLowerCase(); });
  $("#forgotPasswordButton").addEventListener("click", () => void sendPasswordReset());
  $("#existingAccountLogin").addEventListener("click", logInToExistingAccount);
  $("#existingAccountReset").addEventListener("click", () => void resetExistingAccountPassword());
  emailInput.addEventListener("input", () => {
    $("#forgotPasswordButton").hidden = authMode === "create";
  });
  $("#searchInput").addEventListener("input", renderChats);
  $("#archiveViewButton").addEventListener("click", () => {
    archivedView = !archivedView;
    currentPeer = null;
    currentGroup = null;
    currentPeerArchived = false;
    page = "chats";
    clearInterval(messageTimer);
    messenger.classList.remove("show-chat", "show-page");
    renderWelcome();
    void refreshChats();
  });
  $("#newChatButton").addEventListener("click", () => {
    if (page === "groups") {
      void createCommunity();
      return;
    }
    dialogError.hidden = true;
    dialog.showModal();
    identifierInput.focus();
  });
  $("#cancelDialog").addEventListener("click", () => dialog.close());
  $("#newChatForm").addEventListener("submit", findContact);
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".conversation-menu-wrap")) closeConversationMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeConversationMenu();
  });
  $("#acceptCallButton").addEventListener("click", () => void acceptIncomingCall());
  $("#declineCallButton").addEventListener("click", () => void rejectCall());
  $("#endCallButton").addEventListener("click", () => void closeActiveCall(true, "Call ended"));
  $("#hangUpButton").addEventListener("click", () => void closeActiveCall(true, "Call ended"));
  callDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    if (activeCall?.role === "callee" && !activeCall.pc) void rejectCall();
    else void closeActiveCall(true, "Call ended");
  });
  document.querySelectorAll(".nav-button").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.dataset.page === "settings") openSettingsPage();
      else if (button.dataset.page === "groups") openGroupsPage();
      else openChatsPage();
    });
  });
  dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
  window.addEventListener("online", () => { if (profile) void refreshChats(); });

  try {
    if (!supabase) {
      showAuthError("Mingle is not configured yet. The site owner must add a valid Supabase project URL and public anon or publishable key.");
      return;
    }
    const { data, error } = await db().auth.getSession();
    if (error) throw new Error(error.message);
    if (data.session) await showApp(await getMyProfile());
  } catch (error) {
    showAuthError(error.message);
  }
}

applyPreferences();
setAuthMode("login");
void initialize();
