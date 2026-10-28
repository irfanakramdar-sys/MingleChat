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
let eventController = null;
let messageTimer = null;
let toastTimer = null;
let pushKey = null;

const escapeText = (text) => String(text).replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
})[character]);

async function request(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("Accept", "application/json");
  if (options.body) headers.set("Content-Type", "application/json");
  if (options.method && options.method !== "GET") headers.set("X-Requested-With", "Mingle");

  const response = await fetch(path, {
    ...options,
    headers,
    credentials: "same-origin",
    cache: "no-store"
  });
  const data = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(data?.error || `The request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return data;
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
  void refreshChats();
  if (currentPeer?.accountNumber === event.senderAccountNumber) {
    void loadMessages();
    return;
  }

  const message = `${event.senderName}: ${event.preview}`;
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
    showToast(message, event.senderAccountNumber);
  }
}

async function fetchEvents(signal) {
  const response = await fetch("/api/events", {
    headers: { Accept: "text/event-stream" },
    credentials: "same-origin",
    cache: "no-store",
    signal
  });
  if (response.status === 401) throw new Error("Please log in again to receive messages.");
  if (!response.ok || !response.body) throw new Error("Live connection unavailable.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  while (!signal.aborted) {
    const { done, value } = await reader.read();
    if (done) throw new Error("The live connection closed.");
    pending += decoder.decode(value, { stream: true });
    let boundary;
    while ((boundary = pending.indexOf("\n\n")) !== -1) {
      const block = pending.slice(0, boundary);
      pending = pending.slice(boundary + 2);
      const dataLine = block.split("\n").find((line) => line.startsWith("data: "));
      if (!dataLine) continue;
      try {
        const event = JSON.parse(dataLine.slice(6));
        if (event.type === "message" && event.senderId !== profile.id) notifyIncoming(event);
        else if (event.type === "messages-read" || event.type === "chat-changed") void refreshChats();
      } catch (error) {
        console.error("Could not read the live message event:", error);
      }
    }
  }
}

function startLiveConnection() {
  if (eventController) eventController.abort();
  eventController = new AbortController();
  const { signal } = eventController;
  const connect = async () => {
    while (!signal.aborted) {
      try {
        await fetchEvents(signal);
      } catch (error) {
        if (signal.aborted) return;
        console.warn("Live chat disconnected; reconnecting:", error.message);
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }
  };
  void connect();
}

async function refreshChats() {
  if (!profile) return;
  try {
    chats = await request("/api/chats");
    renderChats();
  } catch (error) {
    if (error.status === 401) showLogin();
    else console.error("Could not refresh chats:", error);
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
  if (eventController) eventController.abort();
  clearInterval(refreshTimer);
  clearInterval(messageTimer);
  eventController = null;
  profile = null;
  currentPeer = null;
  chats = [];
  authScreen.hidden = false;
  appShell.hidden = true;
  messenger.classList.remove("show-chat", "show-page");
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
      const registration = await navigator.serviceWorker.register("./sw.js");
      registration.active?.postMessage({ type: "SET_PUBLIC_KEY", publicKey: await getPushKey() });
      navigator.serviceWorker.addEventListener("message", (event) => {
        if (event.data?.type === "OPEN_CHAT" && event.data.accountNumber) void openChat(event.data.accountNumber);
      });
    } catch (error) {
      console.error("Background notifications could not be set up:", error);
    }
  }

  const targetAccount = new URLSearchParams(location.search).get("chat");
  if (targetAccount && /^\d{8}$/.test(targetAccount) && targetAccount !== profile.accountNumber) {
    history.replaceState(null, "", "/");
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
    const authEndpoint = authMode === "create" ? "register" : "login";
    const result = await request(`/api/auth/${authEndpoint}`, {
      method: "POST",
      body: JSON.stringify({ phone, password, name })
    });
    await showApp(result.profile);
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
    currentPeer = await request(`/api/users/${encodeURIComponent(accountNumber)}`);
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
    messageTimer = setInterval(() => void loadMessages(), 3000);
    renderChats();
    messageInput.focus();
  } catch (error) {
    showToast(error.message);
  }
}

async function loadMessages() {
  if (!currentPeer) return;
  try {
    const messages = await request(`/api/chats/${encodeURIComponent(currentPeer.accountNumber)}/messages`);
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
    void refreshChats();
  } catch (error) {
    console.error("Could not load messages:", error);
    if (error.status === 404) {
      clearInterval(messageTimer);
      currentPeer = null;
      messenger.classList.remove("show-chat");
      renderWelcome();
    } else if (error.status === 401) {
      showLogin();
    }
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
    await request(`/api/chats/${encodeURIComponent(currentPeer.accountNumber)}/messages`, {
      method: "POST",
      body: JSON.stringify({ text })
    });
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
       <div class="profile-section"><div class="profile-label">Notifications</div>
        <button id="notificationButton" class="notification-button" type="button">Enable notifications on this device</button></div>
       <button id="logoutButton" class="danger-button" type="button">Log out</button>`
    : `<button id="messageThisPerson" class="primary message-profile-button" type="button">Send a message</button>`;
  contentPanel.innerHTML = `<header class="conversation-header">
      <button id="profileBackButton" class="icon-button back-button" type="button" aria-label="Back to messages"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m14.5 5-7 7 7 7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      <span class="person-name">${isMe ? "Your profile" : "Contact profile"}</span>
    </header>
    <section class="profile-content"><h2>${isMe ? "Your account" : "Contact details"}</h2>
      <p class="content-description">${isMe ? "Your account details are saved securely on this chat server." : "Check this person's account details before sending them a message."}</p>
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
        await request("/api/auth/logout", { method: "POST", body: "{}" });
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
    const person = await request(`/api/users/${encodeURIComponent(accountNumber)}`);
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

async function getPushKey() {
  if (!pushKey) {
    const response = await request("/api/notifications/public-key");
    pushKey = response.publicKey;
  }
  return pushKey;
}

function decodeBase64Url(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - padded.length % 4) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function enableNotifications() {
  const button = $("#notificationButton");
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
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
    const registration = await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: decodeBase64Url(await getPushKey())
      });
    }
    await request("/api/notifications/subscribe", {
      method: "POST",
      body: JSON.stringify(subscription.toJSON())
    });
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
  window.addEventListener("beforeunload", () => eventController?.abort());

  try {
    const result = await request("/api/me");
    await showApp(result.profile);
  } catch (error) {
    if (error.status !== 401) showAuthError(error.message);
  }
}

setAuthMode("login");
void initialize();
