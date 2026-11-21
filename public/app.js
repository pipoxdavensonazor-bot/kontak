(function () {
  "use strict";
  const BUILD = "v17";
  const $ = (id) => document.getElementById(id);
  const STR = {
    kr: { connecting: "Ap konekte…", connected: "Konekte", offline: "Dekonekte", login: "Konekte", register: "Kreye kont", send: "Voye", type: "Ekri mesaj…", search: "Chache non oswa nimewo…", welcome: "Byenveni", typing: "ap ekri…", call: "Apèl videyo", audio: "Apèl odyo", loading: "Tann…" },
    fr: { connecting: "Connexion…", connected: "Connecté", offline: "Déconnecté", login: "Se connecter", register: "Créer un compte", send: "Envoyer", type: "Écrire un message…", search: "Rechercher nom ou numéro…", welcome: "Bienvenue", typing: "écrit…", call: "Appel vidéo", audio: "Appel audio", loading: "Attente…" }
  };
  const ERR = {
    "phone-taken": "Nimewo sa deja gen yon kont. Konekte.",
    "bad-creds": "Nimewo oswa modpas pa bon.",
    "not-auth": "Sesyon fini. Ap rekonekte…",
    "empty": "Mesaj vid.",
    "no-peer": "Moun sa pa egziste.",
    "no-conv": "Konvèsasyon pa jwenn.",
    "photo-big": "Foto a twò lou. Chwazi yon pi piti.",
    "group-need-people": "Mete omwen yon nimewo ki deja gen kont.",
    "Nimewo twò kout (8-15 chif)": "Nimewo twò kout. Mete kòd peyi a, egzanp 50937123456.",
    "Modpas omwen 4 karaktè": "Modpas dwe gen omwen 4 karaktè."
  };

  let lang = localStorage.getItem("kontak_lang") || "kr";
  const T = (k) => (STR[lang] && STR[lang][k]) || STR.kr[k] || k;
  let ws = null, me = null, currentConv = null, currentPeer = null, retry = null;
  let outbox = [];
  try {
    const parsed = JSON.parse(localStorage.getItem("kontak_outbox") || "[]");
    if (Array.isArray(parsed)) outbox = parsed;
  } catch { outbox = []; }

  function toast(m, isErr) {
    const t = $("toast");
    if (!t) return;
    t.textContent = m;
    t.hidden = false;
    t.className = isErr ? "err" : "";
    clearTimeout(t._t);
    t._t = setTimeout(() => { t.hidden = true; }, isErr ? 7000 : 3500);
  }
  function authError(m) {
    const el = $("authError");
    if (el) el.textContent = m || "";
    if (m) toast(m, true);
  }
  function setLoading(btn, on) {
    if (!btn) return;
    if (on) {
      btn._txt = btn._txt || btn.textContent;
      btn.textContent = T("loading");
      btn.disabled = true;
    } else {
      btn.textContent = btn._txt || btn.textContent;
      btn.disabled = false;
    }
  }
  function digits(s) { return String(s || "").replace(/\D/g, ""); }
  function applyLang() {
    $("tabLogin").textContent = T("login");
    $("tabReg").textContent = T("register");
    $("loginBtn").textContent = T("login");
    $("regBtn").textContent = T("register");
    $("msgInput").placeholder = T("type");
    $("sendBtn").textContent = T("send");
    $("callBtn").textContent = T("call");
    $("audioBtn").textContent = T("audio");
    $("searchInput").placeholder = T("search");
    $("langBtn").textContent = lang === "kr" ? "FR" : "KR";
  }

  function setBar(txt, bad) {
    $("connBar").textContent = txt + " · " + BUILD;
    $("connBar").style.borderColor = bad ? "var(--warn)" : "var(--line)";
  }

  function send(obj) {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  function showAuth() {
    $("authView").hidden = false;
    $("mainView").hidden = true;
    $("logoutBtn").hidden = true;
    $("videoOverlay").hidden = true;
    $("incoming").hidden = true;
  }

  function afterAuth() {
    setLoading($("loginBtn"), false);
    setLoading($("regBtn"), false);
    authError("");
    $("authView").hidden = true;
    $("mainView").hidden = false;
    $("logoutBtn").hidden = false;
    toast(T("welcome") + " " + me.name + "!");
    paintMe();
    enablePush();
    send({ type: "getConversations" });
    flushOutbox();
  }

  function explain(code) {
    return ERR[code] || code || "Erè";
  }

  function onMsg(o) {
    if (!o || !o.type) return;
    if (o.type === "auth-ok") {
      me = o.user;
      localStorage.setItem("kontak_phone", me.phone);
      const pending = sessionStorage.getItem("kontak_pending_pass");
      if (pending) {
        localStorage.setItem("kontak_pass", pending);
        sessionStorage.removeItem("kontak_pending_pass");
      }
      afterAuth();
    } else if (o.type === "error") {
      setLoading($("loginBtn"), false);
      setLoading($("regBtn"), false);
      if (o.error === "not-auth") {
        const phone = localStorage.getItem("kontak_phone");
        const pass = localStorage.getItem("kontak_pass");
        if (phone && pass) send({ type: "login", phone, password: pass });
        else showAuth();
        return;
      }
      if (o.error === "bad-creds") localStorage.removeItem("kontak_pass");
      authError(explain(o.error));
    } else if (o.type === "search-results") renderSearch(o.results || []);
    else if (o.type === "conversations") renderConvs(o.list || []);
    else if (o.type === "conversation") {
      if (o.peer) currentPeer = o.peer;
      openChat(o.id);
      if (pendingDial) {
        const audioOnly = pendingDial === "audio";
        pendingDial = null;
        startCall(audioOnly);
      }
    } else if (o.type === "messages") renderMessages(o.messages || [], o.convId);
    else if (o.type === "new-message") onNewMessage(o);
    else if (o.type === "typing") onTyping(o);
    else if (o.type === "callOffer") onIncomingCall(o);
    else if (o.type === "callAnswer") onCallAnswer(o);
    else if (o.type === "callIce") onRemoteIce(o);
    else if (o.type === "callDecline" || o.type === "callHangup") endCall();
    else if (o.type === "callBusy") onCallBusy();
    else if (o.type === "presence") onPresence(o);
    else if (o.type === "photo") {
      photoWait.delete(Number(o.id));
      if (o.photo) savePh(o.id, o.photo);
      renderConvs(convCache);
      if (currentPeer && Number(currentPeer.id) === Number(o.id)) fillAvatar($("chatAvatar"), currentPeer);
      paintMe();
    }
    else if (o.type === "profile-ok") {
      if (o.user && o.user.photo) savePh(o.user.id, o.user.photo);
      me = Object.assign(me || {}, o.user);
      toast("Foto sove");
      paintMe();
    }
    else if (o.type === "conversations-refresh") send({ type: "getConversations" });
    else if (o.type === "messages-read") onRead(o);
  }

  function connect() {
    setBar(T("connecting"));
    if (retry) clearTimeout(retry);
    try { if (ws) ws.close(); } catch {}
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(proto + "//" + location.host + "/ws");
    ws.onopen = () => {
      setBar(T("connected"));
      const phone = localStorage.getItem("kontak_phone");
      const pass = localStorage.getItem("kontak_pass");
      if (phone && pass) send({ type: "login", phone, password: pass });
      else showAuth();
    };
    ws.onmessage = (e) => { try { onMsg(JSON.parse(e.data)); } catch (err) { console.error(err); } };
    ws.onclose = () => {
      setBar(T("offline"), true);
      retry = setTimeout(connect, 2000);
    };
    ws.onerror = () => {};
  }

  $("langBtn").onclick = () => {
    lang = lang === "kr" ? "fr" : "kr";
    localStorage.setItem("kontak_lang", lang);
    applyLang();
  };
  applyLang();

  const contrastBtn = $("contrastBtn");
  if (contrastBtn) {
    if (localStorage.getItem("kontak_hc") === "1") document.body.classList.add("hc");
    contrastBtn.onclick = () => {
      const on = !document.body.classList.contains("hc");
      document.body.classList.toggle("hc", on);
      localStorage.setItem("kontak_hc", on ? "1" : "0");
    };
  }

  $("tabLogin").onclick = () => {
    $("loginForm").hidden = false;
    $("regForm").hidden = true;
    $("tabLogin").className = "grow";
    $("tabReg").className = "ghost grow";
    authError("");
  };
  $("tabReg").onclick = () => {
    $("loginForm").hidden = true;
    $("regForm").hidden = false;
    $("tabReg").className = "grow";
    $("tabLogin").className = "ghost grow";
    authError("");
  };

  function doLogin() {
    const phone = digits($("loginPhoneInput").value);
    const pass = $("loginPassInput").value;
    if (phone.length < 8) return authError("Nimewo twò kout. Egzanp: 50937123456");
    if (pass.length < 4) return authError("Modpas dwe gen omwen 4 karaktè.");
    if (!send({ type: "login", phone, password: pass })) return authError("Pa konekte. Tann 2 segonn epi eseye ankò.");
    sessionStorage.setItem("kontak_pending_pass", pass);
    setLoading($("loginBtn"), true);
  }
  function doRegister() {
    const phone = digits($("regPhoneInput").value);
    const pass = $("regPassInput").value;
    let name = $("regNameInput").value.trim();
    if (!name) name = "Kontak " + (phone.slice(-4) || "User");
    if (phone.length < 8) return authError("Nimewo twò kout. Egzanp: 50937123456");
    if (pass.length < 4) return authError("Modpas dwe gen omwen 4 karaktè.");
    if (!send({ type: "register", name, phone, password: pass })) return authError("Pa konekte. Tann 2 segonn epi eseye ankò.");
    sessionStorage.setItem("kontak_pending_pass", pass);
    setLoading($("regBtn"), true);
  }

  $("loginBtn").onclick = doLogin;
  $("regBtn").onclick = doRegister;
  $("loginPassInput").onkeydown = (e) => { if (e.key === "Enter") doLogin(); };
  $("regPassInput").onkeydown = (e) => { if (e.key === "Enter") doRegister(); };
  $("logoutBtn").onclick = () => {
    localStorage.removeItem("kontak_phone");
    localStorage.removeItem("kontak_pass");
    sessionStorage.removeItem("kontak_pending_pass");
    location.reload();
  };

  $("photoBtn").onclick = () => $("photoInput").click();
  $("photoInput").onchange = () => {
    const file = $("photoInput").files && $("photoInput").files[0];
    $("photoInput").value = "";
    if (!file) return;
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const canvas = document.createElement("canvas");
      const size = 48;
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      const s = Math.min(img.width, img.height);
      ctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
      URL.revokeObjectURL(url);
      let photo = canvas.toDataURL("image/jpeg", 0.4);
      if (photo.length > 12000) photo = canvas.toDataURL("image/jpeg", 0.25);
      if (!send({ type: "setProfile", photo })) return toast("Pa konekte");
    };
    img.src = url;
  };
  $("inviteBtn").onclick = async () => {
    const link = location.origin + "/";
    const text = "Vin pale sou Kontak: " + link;
    try {
      if (navigator.share) await navigator.share({ title: "Kontak", text, url: link });
      else throw new Error("no-share");
    } catch {
      try { await navigator.clipboard.writeText(text); } catch {}
      toast("Lyen kopye");
    }
  };
  $("groupBtn").onclick = () => { $("groupModal").hidden = false; };
  $("groupClose").onclick = () => { $("groupModal").hidden = true; };
  $("groupSave").onclick = () => {
    const title = $("groupTitle").value.trim();
    const phones = $("groupPhones").value.trim();
    if (!phones) return toast("Mete nimewo yo");
    if (!send({ type: "createGroup", title, phones })) return toast("Pa konekte");
    $("groupModal").hidden = true;
    $("groupTitle").value = "";
    $("groupPhones").value = "";
  };

  connect();

  let convCache = [];
  const photos = {};
  const photoWait = new Set();
  try { Object.assign(photos, JSON.parse(localStorage.getItem("kontak_ph") || "{}")); } catch {}
  function savePh(id, photo) {
    if (!id || !photo) return;
    photos[id] = photo;
    const keys = Object.keys(photos);
    while (keys.length > 30) delete photos[keys.shift()];
    try { localStorage.setItem("kontak_ph", JSON.stringify(photos)); } catch {}
  }
  $("searchInput").oninput = () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      const q = $("searchInput").value.trim();
      if (q.length < 1) { $("searchRes").innerHTML = ""; return; }
      send({ type: "search", q });
    }, 300);
  };

  function initial(name) { return (name || "?").charAt(0).toUpperCase(); }
  function when(ts) {
    if (!ts) return "";
    const d = new Date(Number(ts));
    const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    if (d.toDateString() === new Date().toDateString()) return hm;
    return d.toLocaleDateString([], { day: "2-digit", month: "short" });
  }
  function fillAvatar(el, person) {
    if (!el) return;
    el.innerHTML = "";
    const id = person && person.id;
    if (person && person.photo) savePh(id, person.photo);
    const src = (person && person.photo) || (id && photos[id]);
    if (src) {
      const img = document.createElement("img");
      img.alt = "";
      img.src = src;
      el.appendChild(img);
      return;
    }
    el.textContent = initial(person && person.name);
    if (id && person.hasPhoto && !photoWait.has(id)) {
      photoWait.add(id);
      send({ type: "getPhoto", id });
    }
  }
  function paintMe() {
    const el = $("meAvatar");
    if (el && me) fillAvatar(el, me);
  }

  function renderSearch(results) {
    const el = $("searchRes");
    el.innerHTML = "";
    results.forEach((u) => {
      const d = document.createElement("div");
      d.className = "conv";
      const av = document.createElement("div");
      av.className = "avatar";
      fillAvatar(av, u);
      const mid = document.createElement("div");
      mid.className = "grow";
      const b = document.createElement("b");
      b.textContent = u.name || "?";
      const prev = document.createElement("div");
      prev.className = "prev";
      prev.textContent = u.phone || "";
      mid.append(b, prev);
      const dot = document.createElement("span");
      dot.className = "dot" + (u.online ? " on" : "");
      d.append(av, mid, dot);
      d.onclick = () => {
        currentPeer = u;
        send({ type: "getOrCreateConversation", peerId: u.id });
        el.innerHTML = "";
        $("searchInput").value = "";
      };
      el.appendChild(d);
    });
  }

  function renderConvs(list) {
    convCache = list || [];
    const el = $("convList");
    el.innerHTML = "";
    list.forEach((c) => {
      const d = document.createElement("div");
      d.className = "conv" + (Number(currentConv) === Number(c.id) ? " active" : "");
      const av = document.createElement("div");
      av.className = "avatar";
      fillAvatar(av, c.peer);
      const mid = document.createElement("div");
      mid.className = "grow";
      const b = document.createElement("b");
      b.textContent = (c.peer && c.peer.name) || "?";
      const prev = document.createElement("div");
      prev.className = "prev";
      prev.textContent = c.lastBody || (c.peer && c.peer.phone) || "";
      mid.append(b, prev);
      const side = document.createElement("div");
      side.className = "convmeta";
      const tm = document.createElement("div");
      tm.textContent = when(c.lastAt);
      const st = document.createElement("div");
      st.textContent = c.seen ? "vu" : (c.peer && c.peer.online ? "an liy" : "");
      side.append(tm, st);
      d.append(av, mid, side);
      d.onclick = () => { currentConv = c.id; currentPeer = c.peer; openChat(c.id); };
      el.appendChild(d);
    });
  }

  function openChat(convId) {
    currentConv = convId;
    $("chatName").textContent = currentPeer ? currentPeer.name : "—";
    $("chatSub").textContent = currentPeer ? (currentPeer.isGroup ? currentPeer.phone : (currentPeer.online ? "An liy" : currentPeer.phone)) : "";
    $("chatOnline").className = "dot" + (currentPeer && currentPeer.online ? " on" : "");
    fillAvatar($("chatAvatar"), currentPeer);
    $("audioBtn").hidden = !!(currentPeer && currentPeer.isGroup);
    $("callBtn").hidden = !!(currentPeer && currentPeer.isGroup);
    $("tab-msgs").classList.add("in-chat");
    document.body.classList.add("in-chat");
    showTab("msgs");
    $("msgs").innerHTML = "";
    send({ type: "getMessages", convId: Number(convId) });
    send({ type: "getConversations" });
  }
  function closeChat() {
    $("tab-msgs").classList.remove("in-chat");
    document.body.classList.remove("in-chat");
  }
  $("backBtn").onclick = closeChat;

  function renderMessages(list, convId) {
    if (convId && Number(convId) !== Number(currentConv)) return;
    const el = $("msgs");
    el.innerHTML = "";
    list.forEach((m) => {
      const d = document.createElement("div");
      d.className = "msg" + (me && m.from === me.id ? " me" : "");
      const text = document.createElement("div");
      text.textContent = m.body;
      d.appendChild(text);
      if (me && m.from === me.id) {
        const tick = document.createElement("div");
        tick.className = "tick";
        tick.dataset.id = m.id;
        tick.textContent = m.readAt ? "vu" : "voye";
        d.appendChild(tick);
      }
      el.appendChild(d);
    });
    el.scrollTop = el.scrollHeight;
  }

  function onNewMessage(o) {
    if (Number(o.convId) === Number(currentConv)) {
      const d = document.createElement("div");
      d.className = "msg" + (me && o.message.from === me.id ? " me" : "");
      d.textContent = o.message.body;
      $("msgs").appendChild(d);
      $("msgs").scrollTop = $("msgs").scrollHeight;
    }
    send({ type: "getConversations" });
    if (me && o.message && o.message.from !== me.id) {
      const looking = document.hasFocus() && !document.hidden && Number(o.convId) === Number(currentConv);
      if (looking) send({ type: "markRead", convId: Number(o.convId) });
      else notify("Kontak", o.message.body);
    }
  }

  function onRead(o) {
    if (Number(o.convId) !== Number(currentConv)) return;
    document.querySelectorAll("#msgs .tick").forEach((el) => { el.textContent = "vu"; });
  }

  function onPresence(o) {
    if (currentPeer && Number(currentPeer.id) === Number(o.userId)) {
      $("chatOnline").className = "dot" + (o.online ? " on" : "");
      currentPeer.online = o.online;
    }
    if (me) send({ type: "getConversations" });
  }

  function onTyping(o) {
    if (Number(o.convId) !== Number(currentConv)) return;
    $("typingEl").textContent = (o.fromName || "") + " " + T("typing");
    clearTimeout($("typingEl")._t);
    $("typingEl")._t = setTimeout(() => { $("typingEl").textContent = ""; }, 1500);
  }

  $("msgInput").oninput = () => { if (currentConv) send({ type: "typing", convId: Number(currentConv) }); };
  $("sendBtn").onclick = sendMsg;
  $("msgInput").onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMsg(); } };

  function sendMsg() {
    const body = $("msgInput").value.trim();
    if (!body || !currentConv) return;
    if (!navigator.onLine || !ws || ws.readyState !== 1) {
      outbox.push({ convId: Number(currentConv), body });
      localStorage.setItem("kontak_outbox", JSON.stringify(outbox));
      toast("ap tann rezo…");
      $("msgInput").value = "";
      return;
    }
    if (send({ type: "sendMessage", convId: Number(currentConv), body })) $("msgInput").value = "";
  }

  function flushOutbox() {
    while (outbox.length && ws && ws.readyState === 1) {
      const m = outbox.shift();
      send({ type: "sendMessage", convId: Number(m.convId), body: m.body });
    }
    localStorage.setItem("kontak_outbox", JSON.stringify(outbox));
  }
  window.addEventListener("online", flushOutbox);

  function satOn() { return localStorage.getItem("kontak_sat") === "1"; }
  $("satBtn").textContent = satOn() ? "SAT: ON" : "SAT: OFF";
  $("satBtn").onclick = () => {
    const on = !satOn();
    localStorage.setItem("kontak_sat", on ? "1" : "0");
    $("satBtn").textContent = on ? "SAT: ON" : "SAT: OFF";
    toast(on ? "Mòd SAT: odyo ~16 kbps" : "Mòd nòmal");
  };

  $("turnBtn").textContent = "TURN: ON";
  $("turnBtn").onclick = () => {
    $("turnUrlInput").value = localStorage.getItem("kontak_turn_url") || "";
    $("turnUserInput").value = localStorage.getItem("kontak_turn_user") || "";
    $("turnPassInput").value = localStorage.getItem("kontak_turn_pass") || "";
    $("turnModal").hidden = false;
  };
  $("turnCloseBtn").onclick = () => { $("turnModal").hidden = true; };
  $("turnSaveBtn").onclick = () => {
    localStorage.setItem("kontak_turn_url", $("turnUrlInput").value.trim());
    localStorage.setItem("kontak_turn_user", $("turnUserInput").value.trim());
    localStorage.setItem("kontak_turn_pass", $("turnPassInput").value.trim());
    $("turnModal").hidden = true;
    toast("TURN sove");
  };

  let iceCache = null;
  async function iceServers() {
    if (!iceCache || iceCache.exp < Date.now()) {
      try {
        const res = await fetch("/turn");
        const data = await res.json();
        iceCache = { exp: Date.now() + 6 * 3600 * 1000, servers: data.iceServers || [] };
      } catch {
        iceCache = { exp: Date.now() + 60 * 1000, servers: [{ urls: "stun:stun.cloudflare.com:3478" }] };
      }
    }
    const servers = iceCache.servers.slice();
    const url = localStorage.getItem("kontak_turn_url");
    if (url) servers.push({ urls: url, username: localStorage.getItem("kontak_turn_user") || "", credential: localStorage.getItem("kontak_turn_pass") || "" });
    return servers;
  }

  let extras = new Map();
  let peopleCache = [];
  try { peopleCache = JSON.parse(localStorage.getItem("kontak_people") || "[]"); } catch {}

  function flushIce() {
    if (!pc || !pc.remoteDescription) return;
    while (iceQueue.length) pc.addIceCandidate(iceQueue.shift()).catch(() => {});
  }

  function mediaConstraints(wantVideo) {
    if (!wantVideo) return { audio: true, video: false };
    return { audio: true, video: { facingMode: "user" } };
  }

  async function openMedia(wantVideo) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("no-media");
    }
    if (!wantVideo) return navigator.mediaDevices.getUserMedia(mediaConstraints(false));
    try {
      const stream = await navigator.mediaDevices.getUserMedia(mediaConstraints(true));
      const track = stream.getVideoTracks()[0];
      if (track) {
        track.enabled = true;
        try { track.contentHint = "detail"; } catch {}
        await track.applyConstraints({
          width: { ideal: 320 },
          height: { ideal: 240 },
          frameRate: { ideal: 10, max: 12 }
        }).catch(() => {});
      }
      return stream;
    } catch (err) {
      toast("Kamera bloke. Ap eseye odyo sèlman.");
      return navigator.mediaDevices.getUserMedia(mediaConstraints(false));
    }
  }

  function attachVideo(id, stream) {
    const el = $(id);
    if (!el) return;
    el.playsInline = true;
    el.autoplay = true;
    if (id === "localVid") el.muted = true;
    el.srcObject = stream || null;
    if (stream) el.play().catch(() => {});
  }

  async function limitVideoBitrate() {
    if (!pc) return;
    const sender = pc.getSenders().find((s) => s.track && s.track.kind === "video");
    if (!sender) return;
    try {
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      params.encodings[0].maxBitrate = satOn() ? 90000 : 200000;
      params.encodings[0].maxFramerate = satOn() ? 8 : 12;
      await sender.setParameters(params);
    } catch {}
  }

  async function wirePc() {
    pc = new RTCPeerConnection({ iceServers: await iceServers() });
    localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
    pc.onicecandidate = (e) => {
      if (e.candidate) send({ type: "callIce", convId: callConv, candidate: e.candidate.toJSON() });
    };
    pc.ontrack = (e) => {
      let remote = $("remoteVid").srcObject;
      if (!(remote instanceof MediaStream)) remote = new MediaStream();
      if (!remote.getTracks().some((t) => t.id === e.track.id)) remote.addTrack(e.track);
      attachVideo("remoteVid", remote);
      if (e.track.kind === "video") $("callStat").textContent = "Kamera konekte";
    };
    pc.onconnectionstatechange = () => {
      if (!pc) return;
      if (pc.connectionState === "connected") {
        const hasVideo = localStream && localStream.getVideoTracks().some((t) => t.enabled);
        $("callStat").textContent = hasVideo ? "Konekte · videyo" : "Konekte · odyo";
        if (pc._drop) { clearTimeout(pc._drop); pc._drop = null; }
      }
      if (pc.connectionState === "failed") endCall();
      if (pc.connectionState === "disconnected" && !pc._drop) {
        const dying = pc;
        dying._drop = setTimeout(() => {
          if (pc === dying && dying.connectionState === "disconnected") endCall();
        }, 12000);
      }
    };
  }

  async function startCall(audioOnly) {
    if (!currentConv || !currentPeer) return toast("Chwazi yon konvèsasyon");
    if (currentPeer.isGroup) return toast("Apèl gwoup poko pare");
    if (pc) endCall(true);
    callConv = Number(currentConv);
    const wantVideo = !audioOnly;
    $("videoOverlay").hidden = false;
    $("callStat").textContent = wantVideo ? "Ap mande kamera a…" : "Ap mande mikwo a…";
    try {
      localStream = await openMedia(wantVideo);
      const hasVideo = localStream.getVideoTracks().length > 0;
      attachVideo("localVid", localStream);
      $("callStat").textContent = hasVideo ? "Ap rele an videyo…" : "Ap rele an odyo…";
      await wirePc();
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await limitVideoBitrate();
      if (!send({ type: "callOffer", convId: callConv, offer: pc.localDescription.toJSON(), audioOnly: !hasVideo })) {
        $("callStat").textContent = "Pa konekte. Tann 2 segonn.";
        return;
      }
      startRing(true);
    } catch (err) {
      const denied = err && (err.name === "NotAllowedError" || err.name === "PermissionDeniedError");
      const msg = denied
        ? "Mikwo bloke. Nan reglaj Chrome, pèmèt mikwo pou Kontak."
        : "Apèl pa kòmanse. " + ((err && (err.message || err.name)) || "");
      if ($("callStat")) $("callStat").textContent = msg;
      toast(msg);
    }
  }

  function onIncomingCall(o) {
    if (!me || o.from === me.id || !o.offer) return;
    if (pc && callConv && Number(o.convId) === Number(callConv)) {
      pc.setRemoteDescription(new RTCSessionDescription(o.offer)).then(async () => {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await limitVideoBitrate();
        send({ type: "callAnswer", convId: callConv, answer: pc.localDescription.toJSON() });
        flushIce();
      }).catch(() => {});
      return;
    }
    pendingOffer = o;
    $("incomingFrom").textContent = (o.fromName || "Kontak") + " ap rele ou";
    $("incoming").hidden = false;
    startRing(false);
    if (document.hidden || !document.hasFocus()) notify("Apèl Kontak", (o.fromName || "Yon moun") + " ap rele ou");
  }

  $("acceptBtn").onclick = async () => {
    if (pendingOffer && pendingOffer.invite) {
      const o = pendingOffer;
      pendingOffer = null;
      $("incoming").hidden = true;
      stopRing();
      callConv = Number(o.convId) || callConv;
      $("videoOverlay").hidden = false;
      $("callStat").textContent = "Ap antre nan apèl la…";
      try {
        localStream = await openMedia(false);
        attachVideo("localVid", localStream);
        for (const person of (o.with || [])) await meshOfferTo(person.id);
        $("callStat").textContent = "Nan apèl la";
      } catch (err) {
        toast("Mikwo pa disponib");
        endCall();
      }
      return;
    }
    if (!pendingOffer || !pendingOffer.offer) return;
    const o = pendingOffer;
    pendingOffer = null;
    $("incoming").hidden = true;
    stopRing();
    callConv = Number(o.convId);
    const wantVideo = !o.audioOnly;
    $("videoOverlay").hidden = false;
    $("callStat").textContent = wantVideo ? "Ap limen kamera…" : "Ap reponn an odyo…";
    try {
      localStream = await openMedia(wantVideo);
      attachVideo("localVid", localStream);
      $("callStat").textContent = "Ap reponn…";
      await wirePc();
      await pc.setRemoteDescription(new RTCSessionDescription(o.offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await limitVideoBitrate();
      send({ type: "callAnswer", convId: callConv, answer: pc.localDescription.toJSON() });
      flushIce();
    } catch (err) {
      toast("Mikwo/kamera pa disponib");
      endCall();
    }
  };

  $("declineBtn").onclick = () => {
    if (pendingOffer) send({ type: "callDecline", convId: pendingOffer.convId });
    pendingOffer = null;
    $("incoming").hidden = true;
    stopRing();
  };

  function onCallAnswer(o) {
    if (!pc || !o.answer) return;
    stopRing();
    pc.setRemoteDescription(new RTCSessionDescription(o.answer)).then(flushIce).catch(() => {});
  }

  function onRemoteIce(o) {
    if (!o.candidate) return;
    const c = new RTCIceCandidate(o.candidate);
    if (!pc || !pc.remoteDescription) iceQueue.push(c);
    else pc.addIceCandidate(c).catch(() => {});
  }

  let ringTimer = null;
  let ringCtx = null;
  function stopRing() {
    if (ringTimer) clearInterval(ringTimer);
    ringTimer = null;
    if (ringCtx) { ringCtx.close().catch(() => {}); ringCtx = null; }
  }
  function beep(ctx, freq, at, dur) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "sine";
    o.frequency.value = freq;
    g.gain.value = 0.05;
    o.connect(g);
    g.connect(ctx.destination);
    o.start(at);
    o.stop(at + dur);
  }
  function startRing(outgoing) {
    stopRing();
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    ringCtx = new Ctx();
    const burst = () => {
      if (!ringCtx) return;
      const t = ringCtx.currentTime;
      if (outgoing) beep(ringCtx, 440, t, 1);
      else { beep(ringCtx, 440, t, 0.18); beep(ringCtx, 480, t + 0.22, 0.25); }
    };
    burst();
    ringTimer = setInterval(burst, outgoing ? 2500 : 1800);
  }
  async function enablePush() {
    if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) return;
    let perm = Notification.permission;
    if (perm === "default") {
      try { perm = await Notification.requestPermission(); } catch { return; }
    }
    if (perm !== "granted") return;
    try {
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: b64ToBuf(VAPID_PUBLIC)
        });
      }
      send({ type: "pushSubscribe", subscription: sub.toJSON() });
    } catch {
      toast("Enstale aplikasyon an pou resevwa apèl lè telefòn nan fèmen");
    }
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && (!ws || ws.readyState !== 1)) connect();
  });
  async function notify(title, body) {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    try {
      const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
      if (reg && reg.showNotification) await reg.showNotification(title, { body, tag: "kontak", renotify: true });
      else new Notification(title, { body, tag: "kontak" });
    } catch {
      try { new Notification(title, { body }); } catch {}
    }
  }

  function onCallBusy() {
    toast("Moun sa deja nan yon apèl.");
    endCall(false);
  }

  function endCall(notifyPeer = true) {
    stopRing();
    extras.forEach((extra) => { try { extra.close(); } catch {} });
    extras.clear();
    document.querySelectorAll("audio[id^='extraAudio']").forEach((el) => el.remove());
    if (screenTrack) { try { screenTrack.stop(); } catch {} screenTrack = null; }
    if ($("shareBtn")) $("shareBtn").textContent = "Ekran";
    if (pc) { try { pc.close(); } catch {} pc = null; }
    if (localStream) { localStream.getTracks().forEach((t) => t.stop()); localStream = null; }
    $("videoOverlay").hidden = true;
    $("incoming").hidden = true;
    $("remoteVid").srcObject = null;
    $("localVid").srcObject = null;
    if (notifyPeer && callConv) send({ type: "callHangup", convId: callConv });
    callConv = null;
    iceQueue = [];
    pendingOffer = null;
  }
  $("hangBtn").onclick = () => endCall();
  $("muteBtn").onclick = () => {
    if (!localStream) return;
    const t = localStream.getAudioTracks()[0];
    if (!t) return;
    t.enabled = !t.enabled;
    $("muteBtn").textContent = t.enabled ? "Mikwo: ON" : "Mikwo: OFF";
  };
  $("camBtn").onclick = async () => {
    if (!localStream) return;
    let t = localStream.getVideoTracks()[0];
    if (!t && pc) {
      try {
        const cam = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: "user" } });
        t = cam.getVideoTracks()[0];
        localStream.addTrack(t);
        pc.addTrack(t, localStream);
        attachVideo("localVid", localStream);
        $("camBtn").textContent = "Kamera: ON";
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await limitVideoBitrate();
        send({ type: "callOffer", convId: callConv, offer: pc.localDescription.toJSON(), audioOnly: false });
      } catch (err) {
        toast("Kamera pa disponib. Otorize kamera a nan navigatè a.");
      }
      return;
    }
    if (!t) return;
    t.enabled = !t.enabled;
    $("camBtn").textContent = t.enabled ? "Kamera: ON" : "Kamera: OFF";
  };
  $("shareBtn").onclick = async () => {
    if (!pc || !localStream) return;
    const sender = pc.getSenders().find((s) => s.track && s.track.kind === "video");
    if (screenTrack) {
      const ending = screenTrack;
      screenTrack = null;
      ending.onended = null;
      const cam = localStream.getVideoTracks()[0] || null;
      if (sender) await sender.replaceTrack(cam);
      try { ending.stop(); } catch {}
      attachVideo("localVid", localStream);
      $("shareBtn").textContent = "Ekran";
      return;
    }
    try {
      const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      screenTrack = display.getVideoTracks()[0];
      screenTrack.onended = () => { if (screenTrack) $("shareBtn").click(); };
      if (sender) await sender.replaceTrack(screenTrack);
      else {
        pc.addTrack(screenTrack, localStream);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await limitVideoBitrate();
        send({ type: "callOffer", convId: callConv, offer: pc.localDescription.toJSON(), audioOnly: false });
      }
      const preview = new MediaStream([screenTrack]);
      attachVideo("localVid", preview);
      $("shareBtn").textContent = "Kanpe ekran";
    } catch {
      toast("Pataj ekran refize");
    }
  };
  function dialDigit(ch) {
    const el = $("dialShow");
    if (ch === "x") el.textContent = el.textContent.slice(0, -1);
    else if (el.textContent.length < 15) el.textContent += ch;
  }
  $("dialBtn").onclick = () => { $("dialModal").hidden = false; };
  $("dialClose").onclick = () => { $("dialModal").hidden = true; };
  $("dialKeys").onclick = (e) => {
    const k = e.target && e.target.dataset && e.target.dataset.k;
    if (k) dialDigit(k);
  };
  function placeDial(audioOnly) {
    const phone = digits($("dialShow").textContent);
    if (phone.length < 8) return toast("Nimewo twò kout");
    pendingDial = audioOnly ? "audio" : "video";
    $("dialModal").hidden = true;
    if (!send({ type: "dial", phone })) { pendingDial = null; toast("Pa konekte"); }
  }
  $("dialAudio").onclick = () => placeDial(true);
  $("dialVideo").onclick = () => placeDial(false);
  $("callBtn").onclick = () => startCall(false);
  $("audioBtn").onclick = () => startCall(true);

  function showTab(name) {
    ["msgs", "people", "calls", "me"].forEach((n) => {
      const panel = $("tab-" + n);
      if (panel) panel.hidden = n !== name;
      const btn = document.querySelector('#nav [data-tab="' + n + '"]');
      if (btn) btn.className = n === name ? "on" : "";
    });
    if (name === "calls") send({ type: "getCalls" });
    if (name === "people") renderPeople(peopleCache);
    if (name === "me" && me) {
      $("profileName").value = me.name || "";
      $("profilePhone").textContent = me.phone || "";
      paintMe();
    }
  }
  document.querySelectorAll("#nav button").forEach((b) => { b.onclick = () => showTab(b.dataset.tab); });

  function renderPeople(list) {
    const el = $("peopleList");
    if (!el) return;
    el.innerHTML = "";
    if (!list.length) {
      const p = document.createElement("p");
      p.className = "hint";
      p.textContent = "Pa gen kontak Kontak pou kounye a.";
      el.appendChild(p);
      return;
    }
    list.forEach((u) => {
      const d = document.createElement("div");
      d.className = "conv";
      const av = document.createElement("div");
      av.className = "avatar";
      fillAvatar(av, u);
      const mid = document.createElement("div");
      mid.className = "grow";
      const b = document.createElement("b");
      b.textContent = u.name || "?";
      const prev = document.createElement("div");
      prev.className = "prev";
      prev.textContent = u.phone || "";
      mid.append(b, prev);
      d.append(av, mid);
      d.onclick = () => {
        currentPeer = u;
        send({ type: "getOrCreateConversation", peerId: u.id });
        showTab("msgs");
      };
      el.appendChild(d);
    });
  }
  function renderCalls(list) {
    const el = $("callList");
    if (!el) return;
    el.innerHTML = "";
    if (!list.length) {
      const p = document.createElement("p");
      p.className = "hint";
      p.textContent = "Pa gen apèl ankò.";
      el.appendChild(p);
      return;
    }
    const label = { out: "Soti", in: "Resevwa", miss: "Manke" };
    list.forEach((c) => {
      const d = document.createElement("div");
      d.className = "conv";
      const mid = document.createElement("div");
      mid.className = "grow";
      const b = document.createElement("b");
      b.textContent = c.name || c.phone || "Kontak";
      const prev = document.createElement("div");
      prev.className = "prev" + (c.status === "miss" ? " miss" : "");
      prev.textContent = (c.kind === "video" ? "Videyo" : "Odyo") + " · " + (label[c.status] || c.status) + " · " + when(c.at);
      mid.append(b, prev);
      d.append(mid);
      d.onclick = () => {
        currentPeer = { id: c.peerId, name: c.name, phone: c.phone };
        send({ type: "getOrCreateConversation", peerId: c.peerId });
        pendingDial = c.kind === "video" ? "video" : "audio";
        showTab("msgs");
      };
      el.appendChild(d);
    });
  }
  function renderAddList() {
    const el = $("addList");
    el.innerHTML = "";
    const list = peopleCache.filter((u) => !currentPeer || u.id !== currentPeer.id);
    if (!list.length) {
      const p = document.createElement("p");
      p.className = "hint";
      p.textContent = "Chwazi kontak telefòn nan onglet Kontak anvan.";
      el.appendChild(p);
      return;
    }
    list.forEach((u) => {
      const d = document.createElement("div");
      d.className = "conv";
      const b = document.createElement("b");
      b.textContent = (u.name || "?") + " · " + (u.phone || "");
      d.appendChild(b);
      d.onclick = () => {
        const withIds = [];
        if (currentPeer && currentPeer.id) withIds.push(currentPeer.id);
        extras.forEach((_, id) => withIds.push(Number(id)));
        send({ type: "callAdd", to: u.id, convId: callConv, with: withIds });
        $("addModal").hidden = true;
        toast("Ap ajoute " + (u.name || ""));
      };
      el.appendChild(d);
    });
  }
  $("syncContacts").onclick = async () => {
    if (!navigator.contacts || !navigator.contacts.select) return toast("Kontak telefòn mache sou Chrome Android");
    try {
      const picked = await navigator.contacts.select(["name", "tel"], { multiple: true });
      const phones = [];
      for (const c of picked) for (const tel of (c.tel || [])) {
        const d = digits(tel);
        if (d.length >= 8) phones.push(d);
      }
      if (!phones.length) return toast("Pa gen nimewo");
      send({ type: "matchContacts", phones: phones.slice(0, 80) });
    } catch {}
  };
  $("saveProfile").onclick = () => {
    const name = $("profileName").value.trim();
    if (!name) return;
    if (!send({ type: "setProfile", name })) return toast("Pa konekte");
  };
  $("notifyBtn").onclick = () => enablePush();
  $("addBtn").onclick = () => {
    if (!pc && !extras.size) return toast("Pa gen apèl");
    renderAddList();
    $("addModal").hidden = false;
  };
  $("addClose").onclick = () => { $("addModal").hidden = true; };

  function makeExtra(id) {
    const old = extras.get(id);
    if (old) { try { old.close(); } catch {} }
    const extra = new RTCPeerConnection(iceConfig());
    extra._queue = [];
    extra.onicecandidate = (e) => { if (e.candidate) send({ type: "meshIce", to: id, candidate: e.candidate.toJSON() }); };
    extra.ontrack = (e) => {
      let audio = document.getElementById("extraAudio-" + id);
      if (!audio) {
        audio = document.createElement("audio");
        audio.autoplay = true;
        audio.id = "extraAudio-" + id;
        document.body.appendChild(audio);
      }
      audio.srcObject = e.streams[0] || new MediaStream([e.track]);
      $("callStat").textContent = "Yon lòt moun rantre";
    };
    if (localStream) localStream.getAudioTracks().forEach((t) => extra.addTrack(t, localStream));
    extras.set(Number(id), extra);
    return extra;
  }
  async function meshOfferTo(id) {
    const extra = makeExtra(id);
    const offer = await extra.createOffer();
    await extra.setLocalDescription(offer);
    send({ type: "meshOffer", to: id, offer: extra.localDescription.toJSON() });
  }
  function onCallInvite(o) {
    if (pc || extras.size) return toast("Ou deja nan yon apèl");
    pendingOffer = Object.assign({ invite: true }, o);
    $("incomingFrom").textContent = (o.fromName || "Kontak") + " vle ajoute ou nan apèl la";
    $("incoming").hidden = false;
    startRing(false);
    if (document.hidden || !document.hasFocus()) notify("Apèl Kontak", (o.fromName || "Yon moun") + " vle ajoute ou");
  }
  async function onMeshOffer(o) {
    if (!localStream || !o.offer) return;
    const extra = makeExtra(o.from);
    await extra.setRemoteDescription(new RTCSessionDescription(o.offer));
    const queued = extra._queue.splice(0);
    for (const c of queued) { try { await extra.addIceCandidate(c); } catch {} }
    const answer = await extra.createAnswer();
    await extra.setLocalDescription(answer);
    send({ type: "meshAnswer", to: o.from, answer: extra.localDescription.toJSON() });
  }
  async function onMeshAnswer(o) {
    const extra = extras.get(Number(o.from));
    if (!extra || !o.answer) return;
    await extra.setRemoteDescription(new RTCSessionDescription(o.answer));
    const queued = extra._queue.splice(0);
    for (const c of queued) { try { await extra.addIceCandidate(c); } catch {} }
  }
  function onMeshIce(o) {
    const extra = extras.get(Number(o.from));
    if (!extra || !o.candidate) return;
    const c = new RTCIceCandidate(o.candidate);
    if (!extra.remoteDescription) extra._queue.push(c);
    else extra.addIceCandidate(c).catch(() => {});
  }
})();
