import { createClient } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./supabase-config.js";

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

let authMode = "login";
let profile = null;
let chats = [];
let currentPeer = null;
let currentPeerArchived = false;
let page = "chats";
let refreshTimer = null;
let liveChannel = null;
let messageTimer = null;
let toastTimer = null;
let lastChatRefreshError = null;
let lastMessageLoadError = null;
let archivedView = false;
const unlockedPeerIds = new Set();

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
    deletedAt: row.deleted_at
  };
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

async function findProfile(identifier) {
  const { data, error } = await db().rpc("lookup_profile", { p_identifier: identifier.trim().toLowerCase() });
  if (error) throw new Error(error.message);
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error("No Mingle account matches that mobile number or email.");
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
  if ("Notification" in window && Notification.permission === "granted" && document.hidden) {
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
    const notification = new Notification(event.senderName, {
      body: event.preview,
      icon: "./icon.svg",
      tag: `mingle-${event.senderPhone}`,
      data: { identifier: event.senderPhone }
    });
    notification.onclick = () => {
      window.focus();
      void openChat(event.senderPhone);
      notification.close();
    };
  } else {
    showToast(`${event.senderName}: ${event.preview}`, event.senderPhone);
  }
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
          preview: payload.new.text
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
  if (liveChannel) void db().removeChannel(liveChannel);
  liveChannel = null;
  clearInterval(refreshTimer);
  clearInterval(messageTimer);
  profile = null;
  currentPeer = null;
  currentPeerArchived = false;
  archivedView = false;
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
  archivedView = false;
  authScreen.hidden = true;
  appShell.hidden = false;
  $("#listTitle").textContent = "Messages";
  $("#searchInput").parentElement.hidden = false;
  $("#newChatButton").hidden = false;
  messenger.classList.remove("show-chat", "show-page");
  await refreshChats();
  startLiveConnection();
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => void refreshChats(), 30000);

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
  contentPanel.innerHTML = `<div class="welcome"><div class="welcome-mark" aria-hidden="true">M</div>
    <h2>Your conversations</h2>
    <p>Choose a conversation or find someone using their registered mobile number or email address.</p></div>`;
}

async function openChat(identifier) {
  if (messageTimer) clearInterval(messageTimer);
  try {
    const peer = await findProfile(identifier);
    if (!await unlockChat(peer.id)) return;
    currentPeer = peer;
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
        </button><div class="conversation-actions"><button id="archiveChatButton" class="chat-action-button" type="button">${currentPeerArchived ? "Unarchive" : "Archive"}</button><button id="lockChatButton" class="chat-action-button" type="button">${getLockedPeerIds().has(peer.id) ? "Unlock chat" : "Lock chat"}</button></div>
      </header>
      <div class="messages" id="messageList" role="log" aria-label="Messages with ${escapeText(peer.name)}"></div>
      <form id="messageForm" class="composer"><textarea id="messageInput" maxlength="2000" rows="1" aria-label="Type a message" placeholder="Type a message..."></textarea><button class="send-button" type="submit" aria-label="Send message" title="Send message"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m21 3-7.3 18-3.8-7.9L2 9.3 21 3Z" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="m9.9 13.1 4.5-4.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg></button></form>`;
    $("#backButton").addEventListener("click", () => {
      clearInterval(messageTimer);
      currentPeer = null;
      currentPeerArchived = false;
      messenger.classList.remove("show-chat");
      void refreshChats();
      renderWelcome();
    });
    $("#peerProfileButton").addEventListener("click", () => renderProfile(peer));
    $("#archiveChatButton").addEventListener("click", () => void setChatArchived(peer.id, !currentPeerArchived));
    $("#lockChatButton").addEventListener("click", () => void toggleChatLock(peer));
    $("#messageForm").addEventListener("submit", sendMessage);
    const messageInput = $("#messageInput");
    messageInput.addEventListener("keydown", (keyEvent) => {
      if (keyEvent.key === "Enter" && !keyEvent.shiftKey && !keyEvent.isComposing) {
        keyEvent.preventDefault();
        messageInput.form.requestSubmit();
      }
    });
    messageInput.addEventListener("input", () => {
      messageInput.style.height = "auto";
      messageInput.style.height = `${Math.min(messageInput.scrollHeight, 112)}px`;
    });
    await loadMessages();
    messageTimer = setInterval(() => void loadMessages(), 15000);
    messageInput.focus();
  } catch (error) {
    showToast(error.message);
  }
}

async function loadMessages() {
  if (!currentPeer) return;
  try {
    const peer = currentPeer;
    const { data, error } = await db()
      .from("messages")
      .select("id,sender_id,recipient_id,text,created_at,read_at,updated_at,deleted_at")
      .or(`and(sender_id.eq.${profile.id},recipient_id.eq.${peer.id}),and(sender_id.eq.${peer.id},recipient_id.eq.${profile.id})`)
      .order("created_at", { ascending: true })
      .limit(500);
    if (error) throw new Error(error.message);
    const messages = (data || []).map(mapMessage);
    if (!currentPeer || currentPeer.id !== peer.id) return;
    const { error: readError } = await db()
      .from("messages")
      .update({ read_at: new Date().toISOString() })
      .eq("sender_id", peer.id)
      .eq("recipient_id", profile.id)
      .is("read_at", null);
    if (readError) throw new Error(readError.message);
    if (!currentPeer) return;
    const messageList = $("#messageList");
    if (!messageList) return;
    const wasNearBottom = messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight < 120;
    messageList.replaceChildren();
    if (!messages.length) {
      const empty = document.createElement("div");
      empty.className = "empty-list";
      empty.textContent = `You are now connected with ${currentPeer.name}. Send a message to say hello.`;
      messageList.append(empty);
    }
    for (const message of messages) {
      const bubble = document.createElement("article");
      bubble.className = `message${message.senderId === profile.id ? " mine" : ""}`;
      const text = document.createElement("div");
      text.className = message.deletedAt ? "deleted-message" : "";
      text.textContent = message.deletedAt ? "This message was deleted." : message.text;
      const time = document.createElement("div");
      time.className = "message-meta";
      const edited = message.updatedAt ? " · Edited" : "";
      time.textContent = `${timeLabel(message.createdAt)}${edited}${message.readAt ? " · Read" : ""}`;
      bubble.append(text, time);
      if (message.senderId === profile.id && !message.deletedAt) {
        const actions = document.createElement("div");
        actions.className = "message-actions";
        if (Date.now() - new Date(message.createdAt).getTime() <= 15 * 60 * 1000) {
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
    if (wasNearBottom || messages.length <= 1) messageList.scrollTop = messageList.scrollHeight;
    lastMessageLoadError = null;
    void refreshChats();
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
    const { error } = await db().rpc("edit_message", {
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
    const { error } = await db().rpc("delete_message", { p_message_id: message.id });
    if (error) throw new Error(error.message);
    await loadMessages();
  } catch (error) {
    showToast(`Could not delete message: ${error.message}`);
  }
}

async function sendMessage(event) {
  event.preventDefault();
  const input = $("#messageInput");
  const text = input.value.trim();
  if (!currentPeer || !text) return;
  const button = $("#messageForm button[type=submit]");
  button.disabled = true;
  try {
    const { error } = await db().from("messages").insert({
      sender_id: profile.id,
      recipient_id: currentPeer.id,
      text
    });
    if (error) throw new Error(error.message);
    input.value = "";
    input.style.height = "auto";
    input.focus();
    await Promise.all([loadMessages(), refreshChats()]);
  } catch (error) {
    showToast(error.message);
  } finally {
    if (button.isConnected) button.disabled = false;
  }
}

function renderProfile(person = profile) {
  if (!person) return;
  clearInterval(messageTimer);
  if (person.id === profile.id) page = "profile";
  else page = "contact-profile";
  updateNav(person.id === profile.id ? "profile" : "chats");
  if (person.id === profile.id) {
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
       <div class="profile-section"><div class="profile-label">Notifications while Mingle is open</div>
        <button id="notificationButton" class="notification-button" type="button">Enable notifications on this device</button></div>
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
    if (isMe) openChatsPage();
    else void openChat(person.phone);
  });
  if (isMe) {
    if (!person.email) $("#addLoginEmailButton").addEventListener("click", () => void addLoginEmail());
    $("#notificationButton").addEventListener("click", () => void enableNotifications());
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
  page = "chats";
  archivedView = false;
  messenger.classList.remove("show-chat", "show-page");
  $("#listTitle").textContent = "Messages";
  $("#searchInput").parentElement.hidden = false;
  $("#newChatButton").hidden = false;
  updateNav("chats");
  void refreshChats();
  renderWelcome();
}

async function findContact(event) {
  event.preventDefault();
  const identifier = identifierInput.value.trim();
  const isPhone = /^\d{10}$/.test(identifier);
  const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier);
  if (!isPhone && !isEmail) {
    dialogError.textContent = "Enter a 10-digit mobile number or a valid email address.";
    dialogError.hidden = false;
    return;
  }
  $("#startChatSubmit").disabled = true;
  try {
    const person = await findProfile(identifier);
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
  if (!("Notification" in window)) {
    button.textContent = "Notifications are not supported in this browser";
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
    button.textContent = "Notifications enabled on this device";
  } catch (error) {
    button.textContent = `Could not enable notifications: ${error.message}`;
  } finally {
    button.disabled = false;
  }
}

async function initialize() {
  $("#loginTab").addEventListener("click", () => setAuthMode("login"));
  $("#createTab").addEventListener("click", () => setAuthMode("create"));
  authForm.addEventListener("submit", handleAuthentication);
  phoneInput.addEventListener("input", () => { phoneInput.value = phoneInput.value.replace(/\D/g, "").slice(0, 10); });
  identifierInput.addEventListener("input", () => {
    if (/^\d+$/.test(identifierInput.value)) {
      identifierInput.value = identifierInput.value.slice(0, 10);
    }
  });
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
    currentPeerArchived = false;
    clearInterval(messageTimer);
    messenger.classList.remove("show-chat", "show-page");
    renderWelcome();
    void refreshChats();
  });
  $("#newChatButton").addEventListener("click", () => {
    dialogError.hidden = true;
    dialog.showModal();
    identifierInput.focus();
  });
  $("#cancelDialog").addEventListener("click", () => dialog.close());
  $("#newChatForm").addEventListener("submit", findContact);
  document.querySelectorAll(".nav-button").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.dataset.page === "profile") renderProfile(profile);
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

setAuthMode("login");
void initialize();
