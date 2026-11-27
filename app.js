/* 👑 현정님 비서실 — Firebase Realtime Database 동기화 클라이언트 */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getDatabase, ref, query, limitToLast, onValue, push, set, update, remove,
  serverTimestamp, onDisconnect
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

var firebaseConfig = {
  apiKey: "AIzaSyD-T3DTI9y02R_Auxfg0VcY_baiDrDEF98",
  authDomain: "hyunjeong-pickle-office.firebaseapp.com",
  databaseURL: "https://hyunjeong-pickle-office-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "hyunjeong-pickle-office",
  storageBucket: "hyunjeong-pickle-office.firebasestorage.app",
  messagingSenderId: "359310800832",
  appId: "1:359310800832:web:2e9de5e64b2f55c401fa25"
};

var DB_URL = firebaseConfig.databaseURL;
var PAGE_URL = location.origin + location.pathname;
var ME_KEY = "pickleOffice.me";
var FRESH_MS = 150000; // 2분 30초 안에 신호가 있으면 '참여 중'
var STATUSES = ["대기", "진행중", "완료"];

var state = {
  rooms: {},
  members: {},
  presence: {},
  tasks: {},
  messages: [],
  roomId: null,
  myId: "hyunjeong",
  tab: "map",
  taskFilter: "all",
  unread: 0,
  memoDirty: false,
  renderedRoom: null
};

var db = null;
var app = null;
var msgUnsub = null;
var memoTimer = null;

window.__office = { ready: false, errors: [] };
window.addEventListener("error", function (e) {
  window.__office.errors.push(String(e && e.message ? e.message : e));
});
window.addEventListener("unhandledrejection", function (e) {
  window.__office.errors.push(String(e && e.reason ? e.reason : e));
});

function $(id) { return document.getElementById(id); }

function el(tag, cls, text) {
  var node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function toArray(obj) {
  var out = [];
  if (!obj || typeof obj !== "object") return out;
  Object.keys(obj).forEach(function (k) {
    var v = obj[k];
    if (v && typeof v === "object") {
      var item = Object.assign({ id: k }, v);
      out.push(item);
    }
  });
  return out;
}

function byOrder(a, b) {
  var ao = typeof a.order === "number" ? a.order : 99;
  var bo = typeof b.order === "number" ? b.order : 99;
  if (ao !== bo) return ao - bo;
  return String(a.name || a.id).localeCompare(String(b.name || b.id), "ko");
}

function pad2(n) { return n < 10 ? "0" + n : String(n); }

function fmtTime(ts) {
  if (!ts) return "";
  var d = new Date(ts);
  return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
}

function fmtRel(ts) {
  if (!ts) return "기록 없음";
  var diff = Date.now() - ts;
  if (diff < 0) diff = 0;
  if (diff < 60000) return "방금 전";
  var m = Math.floor(diff / 60000);
  if (m < 60) return m + "분 전";
  var h = Math.floor(m / 60);
  if (h < 24) return h + "시간 전";
  var d = Math.floor(h / 24);
  if (d < 7) return d + "일 전";
  var dt = new Date(ts);
  return (dt.getMonth() + 1) + "월 " + dt.getDate() + "일";
}

function fmtDay(ts) {
  var d = new Date(ts);
  return d.getFullYear() + "년 " + (d.getMonth() + 1) + "월 " + d.getDate() + "일";
}

function dayKey(ts) {
  var d = new Date(ts);
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
}

function isFresh(p) {
  return !!p && typeof p.ts === "number" && Date.now() - p.ts < FRESH_MS;
}

function roomName(id) {
  var r = state.rooms[id];
  return r ? r.name : id;
}

function memberOf(id) {
  if (id === "hyunjeng" && !state.members[id] && state.members.hyeonjang) return state.members.hyeonjang;
  return state.members[id] || { name: id, emoji: "💬", color: "#fff6dd" };
}

function setAvatarContent(node, who, fallback) {
  if (who && who.avatarUrl) {
    var img = document.createElement("img");
    img.src = who.avatarUrl;
    img.alt = who.name || "";
    node.textContent = "";
    node.appendChild(img);
  } else {
    node.textContent = (who && who.emoji) || fallback || "💬";
  }
}

function toast(msg) {
  var t = $("toast");
  if (!t) return;
  t.textContent = msg;
  t.hidden = false;
  t.classList.add("is-on");
  clearTimeout(toast._t);
  toast._t = setTimeout(function () {
    t.classList.remove("is-on");
    setTimeout(function () { t.hidden = true; }, 220);
  }, 2400);
}

function banner(msg) {
  var b = $("banner");
  if (!b) return;
  if (!msg) { b.hidden = true; b.textContent = ""; return; }
  b.hidden = false;
  b.textContent = msg;
}

/* ---------------- 탭 ---------------- */
function switchTab(name) {
  state.tab = name;
  var tabs = document.querySelectorAll(".tab");
  Array.prototype.forEach.call(tabs, function (t) {
    var on = t.getAttribute("data-tab") === name;
    t.classList.toggle("is-active", on);
    t.setAttribute("aria-selected", on ? "true" : "false");
  });
  ["map", "chat", "tasks", "team", "memo"].forEach(function (v) {
    var sec = $("view-" + v);
    if (sec) sec.classList.toggle("is-active", v === name);
  });
  if (name === "chat") {
    state.unread = 0;
    renderBadge();
    scrollMessagesToBottom();
    if (state.roomId) pushPresence();
    setTimeout(function () {
      var input = $("msgInput");
      if (input && window.innerWidth > 720) input.focus();
    }, 120);
  }
  if (name === "team") renderMembers();
  if (name === "map") renderPins();
}

function renderBadge() {
  var b = $("chatBadge");
  if (!b) return;
  if (state.unread > 0) {
    b.hidden = false;
    b.textContent = state.unread > 99 ? "99+" : String(state.unread);
  } else {
    b.hidden = true;
    b.textContent = "0";
  }
}

/* ---------------- 오피스 맵 ---------------- */
function renderPins() {
  var stage = $("mapStage");
  if (!stage) return;
  Array.prototype.slice.call(stage.querySelectorAll(".pin")).forEach(function (n) { n.remove(); });

  var rooms = toArray(state.rooms).sort(byOrder);
  rooms.forEach(function (room) {
    var btn = el("button", "pin");
    btn.type = "button";
    btn.setAttribute("data-room", room.id);
    btn.setAttribute("aria-label", room.name + " 회의실로 이동");
    var x = typeof room.x === "number" ? room.x : 50;
    var y = typeof room.y === "number" ? room.y : 50;
    btn.style.left = x + "%";
    btn.style.top = y + "%";

    btn.appendChild(el("span", "pin-emoji", room.emoji || "🚪"));
    var label = el("span", "pin-label", room.name || room.id);
    btn.appendChild(label);

    var avs = el("span", "pin-avs");
    btn.appendChild(avs);

    btn.addEventListener("click", function () { openRoom(room.id); });
    stage.appendChild(btn);
  });

  renderPinAvatars();
}

function memberHome(member) {
  return member.room || (toArray(state.rooms).sort(byOrder)[0] || {}).id || "";
}

function renderPinAvatars() {
  var stage = $("mapStage");
  if (!stage) return;
  var rooms = toArray(state.rooms).sort(byOrder);
  var members = toArray(state.members).sort(byOrder);

  rooms.forEach(function (room) {
    var btn = stage.querySelector('.pin[data-room="' + room.id + '"]');
    if (!btn) return;
    var holder = btn.querySelector(".pin-avs");
    if (!holder) return;
    holder.textContent = "";

    var here = members.filter(function (m) {
      var p = state.presence[m.id];
      if (isFresh(p)) return p.roomId === room.id;
      return memberHome(m) === room.id;
    });
    if (!here.length) { holder.hidden = true; return; }
    holder.hidden = false;

    here.forEach(function (m) {
      var p = state.presence[m.id];
      var live = isFresh(p) && p.roomId === room.id;
      var av = el("i", "av");
      setAvatarContent(av, m, "💬");
      av.style.background = m.color || "#fff6dd";
      av.title = (m.name || "") + (live ? " · 참여 중" : " · 자리 비움");
      if (!live) av.className += " is-away";
      if (m.id === state.myId) av.className += " is-me";
      holder.appendChild(av);
    });
  });
}

function openRoom(roomId) {
  switchTab("chat");
  setRoom(roomId);
}

/* ---------------- 회의실 ---------------- */
function renderRoomBar() {
  var bar = $("roomBar");
  if (!bar) return;
  bar.textContent = "";
  var rooms = toArray(state.rooms).sort(byOrder);
  if (!rooms.length) {
    bar.appendChild(el("span", "small", "방 정보를 불러오는 중…"));
    return;
  }
  rooms.forEach(function (room) {
    var b = el("button", "room-pill" + (room.id === state.roomId ? " is-on" : ""));
    b.type = "button";
    b.appendChild(el("span", "", room.emoji || "🚪"));
    b.appendChild(el("span", "", room.name || room.id));
    if (room.desc) b.appendChild(el("small", "", room.desc));
    b.addEventListener("click", function () { setRoom(room.id); });
    bar.appendChild(b);
  });
}

function setRoom(roomId) {
  if (!roomId || roomId === state.roomId) {
    if (roomId) pushPresence();
    return;
  }
  state.roomId = roomId;
  renderRoomBar();
  subscribeMessages(roomId);
  pushPresence();
}

function subscribeMessages(roomId) {
  if (!db) return;
  if (msgUnsub) { msgUnsub(); msgUnsub = null; }
  state.messages = [];
  state.renderedRoom = null;
  renderMessages(true);
  var q = query(ref(db, "messages/" + roomId), limitToLast(250));
  var firstSnap = true;
  msgUnsub = onValue(q, function (snap) {
    var data = snap.val() || {};
    var arr = toArray(data);
    arr.sort(function (a, b) {
      var at = typeof a.ts === "number" ? a.ts : Date.now();
      var bt = typeof b.ts === "number" ? b.ts : Date.now();
      return at - bt;
    });
    var prevCount = state.messages.length;
    var last = arr.length ? arr[arr.length - 1] : null;
    state.messages = arr;
    renderMessages(false);
    if (!firstSnap && arr.length > prevCount && last && state.tab !== "chat" && last.senderId !== state.myId) {
      state.unread += 1;
      renderBadge();
    }
    firstSnap = false;
  }, function (err) {
    banner("회의실 메시지를 불러오지 못했어요: " + err.message);
  });
}

function isMentioned(text, memberId) {
  if (!text) return false;
  if (text.indexOf("@all") >= 0 || text.indexOf("@전체") >= 0) return true;
  var m = state.members[memberId];
  if (!m || !m.name) return false;
  return text.indexOf("@" + m.name) >= 0;
}

function renderMessages(forceScroll) {
  var list = $("msgList");
  if (!list) return;
  var nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 90;
  var roomChanged = state.renderedRoom !== state.roomId;

  list.textContent = "";

  if (!state.messages.length) {
    var empty = el("div", "msg-empty");
    empty.appendChild(el("div", "", "🪑 아직 이 방에는 대화가 없어요."));
    empty.appendChild(el("div", "", "아래에서 첫 메시지를 남겨 보세요."));
    list.appendChild(empty);
    state.renderedRoom = state.roomId;
    return;
  }

  var lastDay = "";
  state.messages.forEach(function (m) {
    var ts = typeof m.ts === "number" ? m.ts : Date.now();
    var dk = dayKey(ts);
    if (dk !== lastDay) {
      list.appendChild(el("div", "day-sep", fmtDay(ts)));
      lastDay = dk;
    }
    list.appendChild(messageNode(m, ts));
  });

  state.renderedRoom = state.roomId;
  if (forceScroll || roomChanged || nearBottom) scrollMessagesToBottom();
}

function messageNode(m, ts) {
  var mine = m.senderId === state.myId;
  var who = memberOf(m.senderId);
  var row = el("div", "msg" + (mine ? " is-me" : ""));
  if (!mine && isMentioned(m.text, state.myId)) row.className += " is-mention";

  var av = el("div", "avatar");
  setAvatarContent(av, who, "💬");
  av.style.background = who.color || "#fff6dd";
  row.appendChild(av);

  var body = el("div", "msg-body");
  var name = el("div", "msg-who", (m.senderName || who.name || m.senderId || "?"));
  body.appendChild(name);

  var bubble = el("div", "bubble");
  if (m.text) appendWithMentions(bubble, String(m.text));
  if (m.attachment && m.attachment.dataUrl) {
    if (m.attachment.kind === "image") {
      var img = document.createElement("img");
      img.className = "msg-img";
      img.src = m.attachment.dataUrl;
      img.alt = m.attachment.name || "첨부 사진";
      img.addEventListener("click", function () {
        var w = window.open("", "_blank");
        if (w) w.document.write('<img src="' + m.attachment.dataUrl + '" style="max-width:100%;height:auto;">');
      });
      bubble.appendChild(img);
    } else {
      var link = document.createElement("a");
      link.className = "msg-file";
      link.href = m.attachment.dataUrl;
      link.download = m.attachment.name || "file";
      var kb = m.attachment.size ? Math.max(1, Math.round(m.attachment.size / 1024)) + "KB" : "";
      link.textContent = "📄 " + (m.attachment.name || "파일") + (kb ? " (" + kb + ")" : "");
      bubble.appendChild(link);
    }
  }
  body.appendChild(bubble);

  body.appendChild(el("div", "msg-time", fmtTime(ts)));
  row.appendChild(body);
  return row;
}

function appendWithMentions(container, text) {
  var re = /(@[0-9A-Za-z가-힣_]+)/g;
  var last = 0;
  var m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) container.appendChild(document.createTextNode(text.slice(last, m.index)));
    container.appendChild(el("span", "mention", m[0]));
    last = m.index + m[0].length;
  }
  if (last < text.length) container.appendChild(document.createTextNode(text.slice(last)));
}

function scrollMessagesToBottom() {
  var list = $("msgList");
  if (list) list.scrollTop = list.scrollHeight;
}

function renderMentionChips() {
  var row = $("mentionRow");
  if (!row) return;
  row.textContent = "";
  var chips = ["@all", "@전체"];
  toArray(state.members).sort(byOrder).forEach(function (m) {
    if (m.name) chips.push("@" + m.name);
  });
  var seen = {};
  chips.forEach(function (c) {
    if (seen[c]) return;
    seen[c] = true;
    var b = el("button", "mention-chip", c);
    b.type = "button";
    b.addEventListener("click", function () { insertAtCursor(c + " "); });
    row.appendChild(b);
  });
}

function insertAtCursor(text) {
  var input = $("msgInput");
  if (!input) return;
  var start = input.selectionStart;
  var end = input.selectionEnd;
  if (typeof start !== "number") { start = input.value.length; end = start; }
  input.value = input.value.slice(0, start) + text + input.value.slice(end);
  var pos = start + text.length;
  input.focus();
  input.setSelectionRange(pos, pos);
  autoGrow();
}

function renderSenderSelect() {
  var sel = $("senderSelect");
  if (!sel) return;
  sel.textContent = "";
  toArray(state.members).sort(byOrder).forEach(function (m) {
    var o = document.createElement("option");
    o.value = m.id;
    var prefix = m.kind === "client" ? "👑 " : (m.emoji ? m.emoji + " " : "");
    o.textContent = prefix + (m.display || m.name || m.id);
    sel.appendChild(o);
  });
  if (state.members[state.myId]) sel.value = state.myId;
  else {
    var first = sel.options.length ? sel.options[0].value : "";
    if (first) { state.myId = first; sel.value = first; }
  }
}

function autoGrow() {
  var input = $("msgInput");
  if (!input) return;
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 120) + "px";
}

function pushPresence() {
  if (!db || !state.roomId || !state.myId) return;
  var me = memberOf(state.myId);
  var payload = { roomId: state.roomId, ts: Date.now(), name: me.name || state.myId };
  set(ref(db, "presence/" + state.myId), payload).catch(function (e) {
    console.warn("presence failed", e);
  });
}

function registerDisconnect() {
  if (!db || !state.myId) return;
  try {
    onDisconnect(ref(db, "presence/" + state.myId)).remove();
  } catch (e) {
    console.warn("onDisconnect failed", e);
  }
}

var pendingAttachment = null;

function renderAttachPreview() {
  var box = $("attachPreview");
  if (!box) return;
  box.textContent = "";
  if (!pendingAttachment) { box.hidden = true; return; }
  box.hidden = false;
  if (pendingAttachment.kind === "image") {
    var im = document.createElement("img");
    im.src = pendingAttachment.dataUrl;
    box.appendChild(im);
  }
  var label = document.createElement("span");
  label.textContent = (pendingAttachment.kind === "image" ? "📷 " : "📄 ") + pendingAttachment.name;
  box.appendChild(label);
  var rm = document.createElement("button");
  rm.type = "button";
  rm.className = "attach-rm";
  rm.textContent = "✕";
  rm.addEventListener("click", function () {
    pendingAttachment = null;
    var fi = $("fileInput");
    if (fi) fi.value = "";
    renderAttachPreview();
  });
  box.appendChild(rm);
}

function handleFilePick(file) {
  if (!file) return;
  if (file.type && file.type.indexOf("image/") === 0) {
    var reader = new FileReader();
    reader.onload = function (ev) {
      var img = new Image();
      img.onload = function () {
        var maxSide = 900;
        var w = img.width, h = img.height;
        if (w > maxSide || h > maxSide) {
          if (w >= h) { h = Math.round(h * maxSide / w); w = maxSide; }
          else { w = Math.round(w * maxSide / h); h = maxSide; }
        }
        var canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        var dataUrl = canvas.toDataURL("image/jpeg", 0.78);
        pendingAttachment = { kind: "image", name: file.name, size: dataUrl.length, dataUrl: dataUrl };
        renderAttachPreview();
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  } else {
    if (file.size > 1500 * 1024) {
      banner("파일은 1.5MB 이하만 첨부할 수 있어요 (사진은 자동 압축됩니다).");
      return;
    }
    var fr = new FileReader();
    fr.onload = function (ev) {
      pendingAttachment = { kind: "file", name: file.name, size: file.size, dataUrl: ev.target.result };
      renderAttachPreview();
    };
    reader.readAsDataURL(file);
  }
}

function sendMessage() {
  var input = $("msgInput");
  if (!input || !db || !state.roomId) return;
  var text = input.value.trim();
  if (!text && !pendingAttachment) return;

  var me = memberOf(state.myId);
  var payload = {
    senderId: state.myId,
    senderName: me.name || state.myId,
    senderEmoji: me.emoji || "💬",
    text: text,
    ts: serverTimestamp()
  };
  if (pendingAttachment) {
    payload.attachment = pendingAttachment;
  }

  input.value = "";
  pendingAttachment = null;
  var fi = $("fileInput");
  if (fi) fi.value = "";
  renderAttachPreview();
  autoGrow();
  banner("");

  push(ref(db, "messages/" + state.roomId), payload)
    .then(function () {
      pushPresence();
      setTimeout(scrollMessagesToBottom, 120);
    })
    .catch(function (e) {
      input.value = text;
      autoGrow();
      banner("메시지를 보내지 못했어요: " + e.message);
      toast("전송 실패 — 연결을 확인해 주세요");
    });
}

/* ---------------- 작업실 ---------------- */
function renderTaskOwnerSelect() {
  var sel = $("taskOwner");
  if (!sel) return;
  var prev = sel.value;
  sel.textContent = "";
  var all = document.createElement("option");
  all.value = "전체";
  all.textContent = "담당: 전체";
  sel.appendChild(all);
  toArray(state.members).sort(byOrder).forEach(function (m) {
    var o = document.createElement("option");
    o.value = m.name || m.id;
    o.textContent = "담당: " + (m.name || m.id);
    sel.appendChild(o);
  });
  if (prev) sel.value = prev;
}

function renderTasks() {
  var list = $("taskList");
  if (!list) return;
  list.textContent = "";

  var tasks = toArray(state.tasks);
  tasks.sort(function (a, b) {
    var at = typeof a.ts === "number" ? a.ts : 0;
    var bt = typeof b.ts === "number" ? b.ts : 0;
    return bt - at;
  });
  var filtered = state.taskFilter === "all"
    ? tasks
    : tasks.filter(function (t) { return (t.status || "대기") === state.taskFilter; });

  if (!filtered.length) {
    list.appendChild(el("div", "list-empty",
      state.taskFilter === "all" ? "아직 등록된 작업이 없어요. 위에서 추가해 보세요!" : "이 상태의 작업이 없어요."));
    return;
  }

  filtered.forEach(function (t) {
    var status = t.status || "대기";
    var row = el("div", "task");
    row.setAttribute("data-status", status);

    var main = el("div", "task-main");
    main.appendChild(el("div", "task-title", t.title || "(제목 없음)"));
    var meta = el("div", "task-meta");
    if (t.owner) meta.appendChild(el("span", "", "👤 " + t.owner));
    if (t.ts) meta.appendChild(el("span", "", "🕒 " + fmtRel(t.ts)));
    if (t.updatedBy) meta.appendChild(el("span", "", "마지막 수정 " + t.updatedBy));
    main.appendChild(meta);
    row.appendChild(main);

    var st = el("button", "status-btn", status);
    st.type = "button";
    st.setAttribute("data-status", status);
    st.title = "누르면 상태가 바뀌어요";
    st.addEventListener("click", function () { cycleTask(t.id, status); });
    row.appendChild(st);

    var del = el("button", "icon-btn", "🗑");
    del.type = "button";
    del.title = "작업 삭제";
    del.setAttribute("aria-label", "작업 삭제");
    del.addEventListener("click", function () { deleteTask(t); });
    row.appendChild(del);

    list.appendChild(row);
  });
}

function addTask(title, owner) {
  if (!db) return;
  var me = memberOf(state.myId);
  var payload = {
    title: title,
    status: "대기",
    owner: owner || "전체",
    ts: Date.now(),
    createdBy: me.name || state.myId
  };
  push(ref(db, "tasks"), payload).catch(function (e) {
    banner("작업을 추가하지 못했어요: " + e.message);
  });
}

function cycleTask(id, current) {
  if (!db) return;
  var idx = STATUSES.indexOf(current);
  var next = STATUSES[(idx + 1) % STATUSES.length];
  var me = memberOf(state.myId);
  update(ref(db, "tasks/" + id), {
    status: next,
    tsUpdated: Date.now(),
    updatedBy: me.name || state.myId
  }).catch(function (e) {
    banner("상태를 바꾸지 못했어요: " + e.message);
  });
}

function deleteTask(t) {
  if (!db) return;
  var ok = window.confirm('"' + (t.title || "이 작업") + '" 을(를) 삭제할까요?');
  if (!ok) return;
  remove(ref(db, "tasks/" + t.id)).catch(function (e) {
    banner("삭제하지 못했어요: " + e.message);
  });
}

/* ---------------- 비서현황 ---------------- */
function renderMembers() {
  var list = $("memberList");
  if (!list) return;
  list.textContent = "";

  var members = toArray(state.members).sort(byOrder);
  if (!members.length) {
    list.appendChild(el("div", "list-empty", "등록된 피클이 없어요."));
    return;
  }

  members.forEach(function (m) {
    var card = el("div", "member");

    var av = el("div", "avatar");
    setAvatarContent(av, m, "💬");
    av.style.background = m.color || "#fff6dd";
    card.appendChild(av);

    var info = el("div", "member-info");
    var nameRow = el("div", "member-name");
    nameRow.appendChild(document.createTextNode(m.display || m.name || m.id));
    var tag = el("span", "tag " + (m.kind === "pickle" ? "pickle" : "client"),
      m.kind === "pickle" ? "피클" : "대장님");
    nameRow.appendChild(tag);
    if (m.id === state.myId) nameRow.appendChild(el("span", "tag", "나"));
    info.appendChild(nameRow);

    if (m.role) info.appendChild(el("div", "member-role", m.role));

    var p = state.presence[m.id];
    var where = el("div", "member-where");
    var dot = el("span", "dot-live");
    if (isFresh(p)) {
      dot.className = "dot-live on";
      where.appendChild(dot);
      where.appendChild(document.createTextNode(roomName(p.roomId) + "에서 참여 중 · " + fmtRel(p.ts)));
    } else {
      where.appendChild(dot);
      var home = memberHome(m);
      where.appendChild(document.createTextNode(
        "자리 비움" + (home ? " (" + roomName(home) + ")" : "") + " · 마지막 활동 " + fmtRel(p ? p.ts : m.lastSeen)));
    }
    info.appendChild(where);
    card.appendChild(info);
    list.appendChild(card);
  });
}

function renderInvite() {
  var page = $("pageUrlView");
  if (page) page.textContent = PAGE_URL;
  var dbUrl = $("dbUrlView");
  if (dbUrl) dbUrl.textContent = DB_URL;

  var guide = $("joinGuide");
  if (guide) {
    guide.textContent =
      "[피클 합동 비서실 합류]\n" +
      "1) 화면: " + PAGE_URL + "\n" +
      "2) 데이터: Firebase Realtime Database → " + DB_URL + "\n" +
      "- 메시지: /messages/{방}/{메시지ID} = {senderId, senderName, text, ts}\n" +
      "- 작업: /tasks/{작업ID} = {title, status(대기·진행중·완료), owner, ts}\n" +
      "- 메모: /memo = {text, updatedBy, updatedAt}\n" +
      "- 참석 표시: /presence/{피클ID} = {roomId, ts, name}\n" +
      "- 방 ID: jihwi(지휘실) / meeting(대회의실) / lounge(라운지)\n" +
      "3) 인증 없이 읽기·쓰기 가능한 공개 규칙이라, 위 주소로 바로 읽고 쓰면 화면에 실시간 반영됩니다.";
  }
}

function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(function () {
      toast("복사했어요!");
    }).catch(function () { fallbackCopy(text); });
  } else {
    fallbackCopy(text);
  }
}

function fallbackCopy(text) {
  var ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand("copy");
    toast("복사했어요!");
  } catch (e) {
    toast("복사에 실패했어요 — 길게 눌러 선택해 주세요");
  }
  document.body.removeChild(ta);
}

/* ---------------- 메모 ---------------- */
function setMemoStatus(text) {
  var s = $("memoStatus");
  if (s) s.textContent = text;
}

function saveMemo() {
  if (!db) return;
  var box = $("memoBox");
  if (!box) return;
  var me = memberOf(state.myId);
  state.memoDirty = false;
  set(ref(db, "memo"), {
    text: box.value,
    updatedBy: me.name || state.myId,
    updatedAt: Date.now()
  }).then(function () {
    setMemoStatus("저장됨 · " + fmtTime(Date.now()) + " · " + (me.name || state.myId));
  }).catch(function (e) {
    setMemoStatus("저장 실패: " + e.message);
  });
}

/* ---------------- Firebase 구독 ---------------- */
function subscribeAll() {
  var everConnected = false;
  onValue(ref(db, ".info/connected"), function (snap) {
    var on = snap.val() === true;
    if (on) everConnected = true;
    var conn = $("conn");
    var txt = $("connText");
    var st = on ? "connected" : (everConnected ? "offline" : "connecting");
    if (conn) conn.setAttribute("data-state", st);
    if (txt) {
      txt.textContent = on ? "실시간 연결" : (everConnected ? "연결 끊김 — 다시 연결 중" : "연결 중…");
    }
    if (on) { pushPresence(); registerDisconnect(); }
  });

  onValue(ref(db, "rooms"), function (snap) {
    state.rooms = snap.val() || {};
    renderRoomBar();
    renderPins();
    renderMembers();
    if (!state.roomId) {
      var rooms = toArray(state.rooms).sort(byOrder);
      var preferred = rooms.filter(function (r) { return r.id === "meeting"; })[0] || rooms[0];
      if (preferred) setRoom(preferred.id);
    }
  });

  onValue(ref(db, "members"), function (snap) {
    state.members = snap.val() || {};
    renderSenderSelect();
    renderTaskOwnerSelect();
    renderMentionChips();
    renderPins();
    renderMembers();
    renderMessages(false);
  });

  onValue(ref(db, "presence"), function (snap) {
    state.presence = snap.val() || {};
    renderPinAvatars();
    if (state.tab === "team") renderMembers();
  });

  onValue(ref(db, "tasks"), function (snap) {
    state.tasks = snap.val() || {};
    renderTasks();
  });

  onValue(ref(db, "memo"), function (snap) {
    var box = $("memoBox");
    if (!box) return;
    var data = snap.val() || {};
    var focused = document.activeElement === box;
    if (!focused && !state.memoDirty) {
      box.value = data.text || "";
    }
    if (!focused) {
      state.memoDirty = false;
      if (data.updatedAt) {
        setMemoStatus("저장됨 · " + fmtTime(data.updatedAt) + (data.updatedBy ? " · " + data.updatedBy : ""));
      } else {
        setMemoStatus("아직 메모가 없어요 — 적으면 모두에게 저장돼요");
      }
    }
  }, function (err) {
    setMemoStatus("메모를 불러오지 못했어요: " + err.message);
  });
}

/* ---------------- 이벤트 ---------------- */
function bindEvents() {
  Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (t) {
    t.addEventListener("click", function () { switchTab(t.getAttribute("data-tab")); });
  });

  var composer = $("composer");
  if (composer) {
    composer.addEventListener("submit", function (e) {
      e.preventDefault();
      sendMessage();
    });
  }

  var attachBtn = $("attachBtn");
  var fileInput = $("fileInput");
  if (attachBtn && fileInput) {
    attachBtn.addEventListener("click", function () { fileInput.click(); });
    fileInput.addEventListener("change", function () {
      if (fileInput.files && fileInput.files[0]) handleFilePick(fileInput.files[0]);
    });
  }

  var input = $("msgInput");
  if (input) {
    input.addEventListener("input", autoGrow);
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        sendMessage();
      }
    });
  }

  var sender = $("senderSelect");
  if (sender) {
    sender.addEventListener("change", function () {
      state.myId = sender.value;
      try { localStorage.setItem(ME_KEY, state.myId); } catch (e) { /* private mode */ }
      registerDisconnect();
      pushPresence();
      renderMessages(false);
      renderPinAvatars();
      toast((memberOf(state.myId).name || state.myId) + "(으)로 말합니다");
    });
  }

  var taskForm = $("taskForm");
  if (taskForm) {
    taskForm.addEventListener("submit", function (e) {
      e.preventDefault();
      var titleEl = $("taskTitle");
      var ownerEl = $("taskOwner");
      var title = titleEl ? titleEl.value.trim() : "";
      if (!title) return;
      addTask(title, ownerEl ? ownerEl.value : "전체");
      if (titleEl) titleEl.value = "";
      toast("작업을 추가했어요");
    });
  }

  var filter = $("taskFilter");
  if (filter) {
    filter.addEventListener("click", function (e) {
      var btn = e.target.closest ? e.target.closest(".chip") : null;
      if (!btn) return;
      state.taskFilter = btn.getAttribute("data-filter");
      Array.prototype.forEach.call(filter.querySelectorAll(".chip"), function (c) {
        c.classList.toggle("is-on", c === btn);
      });
      renderTasks();
    });
  }

  var memberForm = $("memberForm");
  if (memberForm) {
    memberForm.addEventListener("submit", function (e) {
      e.preventDefault();
      if (!db) return;
      var nameEl = $("mName");
      var emojiEl = $("mEmoji");
      var roleEl = $("mRole");
      var name = nameEl ? nameEl.value.trim() : "";
      if (!name) return;
      var id = "p" + Date.now();
      var rooms = toArray(state.rooms).sort(byOrder);
      var payload = {
        name: name,
        display: name,
        emoji: (emojiEl && emojiEl.value.trim()) || "🍩",
        color: "#f3dca8",
        role: (roleEl && roleEl.value.trim()) || "새로 합류한 피클",
        kind: "pickle",
        room: rooms.length ? rooms[0].id : "meeting",
        order: 50,
        lastSeen: 0
      };
      set(ref(db, "members/" + id), payload).then(function () {
        if (nameEl) nameEl.value = "";
        if (emojiEl) emojiEl.value = "";
        if (roleEl) roleEl.value = "";
        toast(name + " 님을 명단에 올렸어요");
      }).catch(function (err) {
        banner("피클을 등록하지 못했어요: " + err.message);
      });
    });
  }

  Array.prototype.forEach.call(document.querySelectorAll(".copy-btn"), function (b) {
    b.addEventListener("click", function () {
      var target = $(b.getAttribute("data-copy"));
      if (target) copyText(target.textContent);
    });
  });

  var memoBox = $("memoBox");
  if (memoBox) {
    memoBox.addEventListener("input", function () {
      state.memoDirty = true;
      setMemoStatus("입력 중…");
      clearTimeout(memoTimer);
      memoTimer = setTimeout(saveMemo, 900);
    });
  }

  var memoSave = $("memoSave");
  if (memoSave) {
    memoSave.addEventListener("click", function () {
      clearTimeout(memoTimer);
      saveMemo();
      toast("메모를 저장했어요");
    });
  }

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") pushPresence();
  });

  setInterval(function () {
    if (document.visibilityState === "visible") pushPresence();
  }, 60000);

  setInterval(function () {
    if (state.tab === "team") renderMembers();
    renderPinAvatars();
  }, 30000);
}

/* ---------------- 시작 ---------------- */
function boot() {
  try { state.myId = localStorage.getItem(ME_KEY) || "hyunjeong"; } catch (e) { state.myId = "hyunjeong"; }

  bindEvents();
  renderInvite();
  renderMentionChips();

  try {
    app = initializeApp(firebaseConfig);
    db = getDatabase(app);
  } catch (e) {
    banner("Firebase를 시작하지 못했어요: " + e.message);
    var txt = $("connText");
    if (txt) txt.textContent = "연결 실패";
    return;
  }

  subscribeAll();
  switchTab("map");
  window.__office.ready = true;
  window.__office.dbUrl = DB_URL;
  window.__office.pageUrl = PAGE_URL;
}

boot();
