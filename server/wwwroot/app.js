import { createClient } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./supabase-config.js";

const $ = (selector) => document.querySelector(selector);
const authScreen = $("#authScreen");
const appShell = $("#appShell");
const messenger = $("#messenger");
const authForm = $("#authForm");
const authError = $("#authError");
const authSubmit = $("#authSubmit");
const phoneInput = $("#phoneNumber");
const passwordInput = $("#password");
const displayNameInput = $("#displayName");
const nameField = $("#nameField");
const chatList = $("#chatList");
const contentPanel = $("#contentPanel");
const dialog = $("#newChatDialog");
const accountNumberInput = $("#accountNumberInput");
const dialogError = $("#dialogError");
const toast = $("#toast");

let authMode = "login";
let profile = null;
let chats = [];
let currentPeer = null;
let page = "chats";
let refreshTimer = null;
let liveChannel = null;
let messageTimer = null;
let toastTimer = null;
let lastChatRefreshError = null;
let lastMessageLoadError = null;

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
    accountNumber: row.account_number,
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
    readAt: row.read_at
  };
}

function loginEmail(phone) {
  return `m${phone}@accounts.mingle.invalid`;
}

async function getMyProfile() {
  const { data, error } = await db().rpc("ensure_my_profile");
  if (error) throw new Error(error.message);
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error("Your account profile could not be loaded. Please log in again.");
  return mapProfile(row);
}

async function findProfile(accountNumber) {
  const { data, error } = await db().rpc("lookup_profile", { p_account_number: accountNumber });
  if (error) throw new Error(error.message);
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error("No account matches that number.");
  return mapProfile(row);
}

function showAuthError(message) {
  authError.textContent = message;
  authError.hidden = false;
}

function initials(name) {
  return String(name || "?").trim().split(/\s+/).slice(0, 2).map((part) => part[0] || "").join("").toUpperCase();
}

function timeLabel(value) {
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
  displayNameInput.required = create;
  passwordInput.autocomplete = create ? "new-password" : "current-password";
  passwordInput.minLength = create ? 8 : 8;
  authSubmit.textContent = create ? "Create account" : "Log in";
  $("#loginTab").classList.toggle("active", !create);
  $("#createTab").classList.toggle("active", create);
  $("#loginTab").setAttribute("aria-selected", String(!create));
  $("#createTab").setAttribute("aria-selected", String(create));
  authError.hidden = true;
}

function updateNav(activePage) {
  document.querySelectorAll(".nav-button").forEach((button) => {
    button.classList.toggle("active", button.dataset.page === activePage);
  });
}

function showToast(message, accountNumber = null) {
  toast.replaceChildren();
  toast.append(document.createTextNode(message));
  if (accountNumber) {
    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.textContent = "Open chat";
    openButton.addEventListener("click", () => void openChat(accountNumber));
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
      tag: `mingle-${event.senderAccountNumber}`,
      data: { accountNumber: event.senderAccountNumber }
    });
    notification.onclick = () => {
      window.focus();
      void openChat(event.senderAccountNumber);
      notification.close();
    };
  } else {
    showToast(`${event.senderName}: ${event.preview}`, event.senderAccountNumber);
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
        const sender = chats.find((chat) => chat.id === payload.new.sender_id);
        if (!sender) return;
        notifyIncoming({
          senderId: sender.id,
          senderName: sender.name,
          senderAccountNumber: sender.accountNumber,
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
      if (payload.new.read_at && currentPeer?.id === payload.new.recipient_id) {
        void loadMessages();
      }
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
    const { data, error } = await db().rpc("get_chat_summaries");
    if (error) throw new Error(error.message);
    chats = (data || []).map((chat) => ({
      id: chat.id,
      name: chat.name,
      phone: chat.phone,
      accountNumber: chat.account_number,
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
  const visible = chats.filter((chat) => `${chat.name} ${chat.accountNumber} ${chat.lastMessage}`.toLowerCase().includes(search));
  $("#chatCount").textContent = String(visible.length);

  for (const chat of visible) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = `chat-row${currentPeer?.accountNumber === chat.accountNumber ? " selected" : ""}`;
    row.setAttribute("aria-label", `Open conversation with ${chat.name}`);
    const preview = chat.lastMessage
      ? `${chat.lastSenderId === profile.id ? "You: " : ""}${chat.lastMessage}`
      : `Account #${chat.accountNumber}`;
    row.innerHTML = `<span class="avatar">${escapeText(initials(chat.name))}</span>
      <span class="row-copy">
        <span class="row-top"><span class="row-name">${escapeText(chat.name)}</span><span class="row-time">${escapeText(timeLabel(chat.updatedAt))}</span></span>
        <span class="row-bottom"><span class="row-preview">${escapeText(preview)}</span>${chat.unread ? `<span class="unread-badge">${chat.unread > 99 ? "99+" : chat.unread}</span>` : ""}</span>
      </span>`;
    row.addEventListener("click", () => void openChat(chat.accountNumber));
    chatList.append(row);
  }
  if (!visible.length) {
    const empty = document.createElement("div");
    empty.className = "empty-list";
    empty.textContent = search ? "No conversations match your search." : "No conversations yet. Select + to message someone's account number.";
    chatList.append(empty);
  }
}

function showLogin() {
  if (liveChannel) void db().removeChannel(liveChannel);
  liveChannel = null;
  clearInterval(refreshTimer);
  clearInterval(messageTimer);
  profile = null;
  currentPeer = null;
  chats = [];
  authScreen.hidden = false;
  appShell.hidden = true;
  messenger.classList.remove("show-chat", "show-page");
  passwordInput.value = "";
  passwordInput.value = "";
  setAuthMode("login");
}

async function showApp(userProfile) {
  profile = userProfile;
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
      await navigator.serviceWorker.register("./sw.js");
    } catch (error) {
      console.error("Offline website caching could not be set up:", error);
    }
  }

  const targetAccount = new URLSearchParams(location.search).get("chat");
  if (targetAccount && /^\d{8}$/.test(targetAccount) && targetAccount !== profile.accountNumber) {
    history.replaceState(null, "", location.pathname);
    await openChat(targetAccount);
  }
}

async function handleAuthentication(event) {
  event.preventDefault();
  authError.hidden = true;
  const phone = phoneInput.value.trim();
  const password = passwordInput.value;
  const name = displayNameInput.value.trim();

  if (!/^\d{10}$/.test(phone)) {
    showAuthError("Enter exactly 10 digits for your mobile number.");
    phoneInput.focus();
    return;
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
        email: loginEmail(phone),
        password,
        options: { data: { name } }
      });
      if (error) throw new Error(error.message);
      if (!data.session) {
        throw new Error("Account created, but Supabase is asking for email confirmation. The site owner must turn off email confirmations in Supabase Auth settings.");
      }
      await showApp(await getMyProfile());
    } else {
      const { data, error } = await db().auth.signInWithPassword({
        email: loginEmail(phone),
        password
      });
      if (error) throw new Error(error.message);
      if (!data.session) throw new Error("Login did not create a session. Please try again.");
      await showApp(await getMyProfile());
    }
  } catch (error) {
    showAuthError(error.message);
  } finally {
    authSubmit.disabled = false;
    authSubmit.textContent = authMode === "create" ? "Create account" : "Log in";
  }
}

function renderWelcome() {
  contentPanel.innerHTML = `<div class="welcome"><div class="welcome-mark" aria-hidden="true">M</div>
    <h2>Your conversations</h2>
    <p>Choose an account from your chat list or enter their unique account number to get started.</p></div>`;
}

async function openChat(accountNumber) {
  if (messageTimer) clearInterval(messageTimer);
  try {
    currentPeer = await findProfile(accountNumber);
    page = "chats";
    updateNav("chats");
    $("#listTitle").textContent = "Messages";
    $("#searchInput").parentElement.hidden = false;
    $("#newChatButton").hidden = false;
    messenger.classList.remove("show-page");
    messenger.classList.add("show-chat");
    const peer = currentPeer;
    contentPanel.innerHTML = `<header class="conversation-header">
        <button id="backButton" class="icon-button back-button" type="button" aria-label="Back to messages"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m14.5 5-7 7 7 7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
        <button id="peerProfileButton" class="person profile-trigger" type="button" aria-label="View ${escapeText(peer.name)}'s profile">
          <span class="avatar">${escapeText(initials(peer.name))}</span><span><span class="person-name">${escapeText(peer.name)}</span><span class="person-summary">Account #${escapeText(peer.accountNumber)} · View profile</span></span>
        </button>
      </header>
      <div class="messages" id="messageList" role="log" aria-label="Messages with ${escapeText(peer.name)}"></div>
      <form id="messageForm" class="composer"><textarea id="messageInput" maxlength="2000" rows="1" aria-label="Type a message" placeholder="Type a message..."></textarea><button class="send-button" type="submit" aria-label="Send message" title="Send message"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m21 3-7.3 18-3.8-7.9L2 9.3 21 3Z" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="m9.9 13.1 4.5-4.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg></button></form>`;
    $("#backButton").addEventListener("click", () => {
      clearInterval(messageTimer);
      currentPeer = null;
      messenger.classList.remove("show-chat");
      void refreshChats();
      renderWelcome();
    });
    $("#peerProfileButton").addEventListener("click", () => renderProfile(peer));
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
    renderChats();
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
      .select("id,sender_id,recipient_id,text,created_at,read_at")
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
      text.textContent = message.text;
      const time = document.createElement("div");
      time.className = "message-meta";
      time.textContent = `${escapeText(timeLabel(message.createdAt))}${message.readAt ? " · Read" : ""}`;
      bubble.append(text, time);
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
    ? `<div class="profile-section"><div class="profile-label">Your account number</div><div class="profile-value" id="ownAccountNumber"></div>
        <button id="copyAccountNumber" class="notification-button" type="button">Copy account number</button></div>
       <div class="profile-section"><div class="profile-label">Notifications while Mingle is open</div>
        <button id="notificationButton" class="notification-button" type="button">Enable notifications on this device</button></div>
       <button id="logoutButton" class="danger-button" type="button">Log out</button>`
    : `<button id="messageThisPerson" class="primary message-profile-button" type="button">Send a message</button>`;
  contentPanel.innerHTML = `<header class="conversation-header">
      <button id="profileBackButton" class="icon-button back-button" type="button" aria-label="Back to messages"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m14.5 5-7 7 7 7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      <span class="person-name">${isMe ? "Your profile" : "Contact profile"}</span>
    </header>
    <section class="profile-content"><h2>${isMe ? "Your account" : "Contact details"}</h2>
      <p class="content-description">${isMe ? "Your account details are saved securely in the Mingle database." : "Check this person's account details before sending them a message."}</p>
      <div class="profile-card"><span class="avatar">${escapeText(initials(person.name))}</span>
        <div><div class="profile-name">${escapeText(person.name)}</div><div class="profile-detail">Member since ${escapeText(new Date(person.createdAt).toLocaleDateString())}</div></div></div>
      <div class="profile-label">Mobile number</div><div class="profile-value">${escapeText(person.phone)}</div>
      <div class="profile-label">Account number</div><div class="profile-value">${escapeText(person.accountNumber)}</div>
      ${ownFields}
    </section>`;
  $("#profileBackButton").addEventListener("click", () => {
    if (isMe) openChatsPage();
    else void openChat(person.accountNumber);
  });
  if (isMe) {
    $("#ownAccountNumber").textContent = person.accountNumber;
    $("#copyAccountNumber").addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(person.accountNumber);
        showToast("Account number copied.");
      } catch {
        showToast(`Your account number is ${person.accountNumber}.`);
      }
    });
    $("#notificationButton").addEventListener("click", () => void enableNotifications());
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
    $("#messageThisPerson").addEventListener("click", () => void openChat(person.accountNumber));
  }
}

function openChatsPage() {
  page = "chats";
  messenger.classList.remove("show-chat", "show-page");
  $("#listTitle").textContent = "Messages";
  $("#searchInput").parentElement.hidden = false;
  $("#newChatButton").hidden = false;
  updateNav("chats");
  void refreshChats();
  renderWelcome();
}

async function findAccount(event) {
  event.preventDefault();
  const accountNumber = accountNumberInput.value.trim();
  if (!/^\d{8}$/.test(accountNumber)) {
    dialogError.textContent = "Enter an 8-digit account number.";
    dialogError.hidden = false;
    return;
  }
  $("#startChatSubmit").disabled = true;
  try {
    const person = await findProfile(accountNumber);
    dialog.close();
    accountNumberInput.value = "";
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
  accountNumberInput.addEventListener("input", () => { accountNumberInput.value = accountNumberInput.value.replace(/\D/g, "").slice(0, 8); });
  $("#searchInput").addEventListener("input", renderChats);
  $("#newChatButton").addEventListener("click", () => {
    dialogError.hidden = true;
    dialog.showModal();
    accountNumberInput.focus();
  });
  $("#cancelDialog").addEventListener("click", () => dialog.close());
  $("#newChatForm").addEventListener("submit", findAccount);
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
