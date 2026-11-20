(function () {
  "use strict";
  const BUILD = "v8";
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
    askNotify();
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
    } else if (o.type === "messages") renderMessages(o.messages || [], o.convId);
    else if (o.type === "new-message") onNewMessage(o);
    else if (o.type === "typing") onTyping(o);
    else if (o.type === "callOffer") onIncomingCall(o);
    else if (o.type === "callAnswer") onCallAnswer(o);
    else if (o.type === "callIce") onRemoteIce(o);
    else if (o.type === "callDecline" || o.type === "callHangup") endCall();
    else if (o.type === "callBusy") onCallBusy();
    else if (o.type === "presence") onPresence(o);
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

  connect();

  let searchTimer;
  $("searchInput").oninput = () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      const q = $("searchInput").value.trim();
      if (q.length < 1) { $("searchRes").innerHTML = ""; return; }
      send({ type: "search", q });
    }, 300);
  };

  function initial(name) { return (name || "?").charAt(0).toUpperCase(); }

  function renderSearch(results) {
    const el = $("searchRes");
    el.innerHTML = "";
    results.forEach((u) => {
      const d = document.createElement("div");
      d.className = "conv";
      d.innerHTML = `<div class="avatar">${initial(u.name)}</div><div class="grow"><b></b><div class="prev"></div></div><span class="dot${u.online ? " on" : ""}"></span>`;
      d.querySelector("b").textContent = u.name || "?";
      d.querySelector(".prev").textContent = u.phone || "";
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
    const el = $("convList");
    el.innerHTML = "";
    list.forEach((c) => {
      const d = document.createElement("div");
      d.className = "conv" + (Number(currentConv) === Number(c.id) ? " active" : "");
      d.innerHTML = `<div class="avatar">${initial(c.peer && c.peer.name)}</div><div class="grow"><b></b><span class="dot${c.peer && c.peer.online ? " on" : ""}"></span><div class="prev"></div></div>`;
      d.querySelector("b").textContent = (c.peer && c.peer.name) || "?";
      d.querySelector(".prev").textContent = (c.lastBody || (c.peer && c.peer.phone) || "");
      d.onclick = () => { currentConv = c.id; currentPeer = c.peer; openChat(c.id); };
      el.appendChild(d);
    });
  }

  function openChat(convId) {
    currentConv = convId;
    $("chatName").textContent = currentPeer ? currentPeer.name : "—";
    $("chatSub").textContent = currentPeer ? currentPeer.phone : "";
    $("chatOnline").className = "dot" + (currentPeer && currentPeer.online ? " on" : "");
    $("msgs").innerHTML = "";
    send({ type: "getMessages", convId: Number(convId) });
    send({ type: "getConversations" });
  }

  function renderMessages(list, convId) {
    if (convId && Number(convId) !== Number(currentConv)) return;
    const el = $("msgs");
    el.innerHTML = "";
    list.forEach((m) => {
      const d = document.createElement("div");
      d.className = "msg" + (me && m.from === me.id ? " me" : "");
      d.textContent = m.body;
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
      if (!looking) notify("Kontak", o.message.body);
    }
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

  let pc = null, localStream = null, callConv = null, pendingOffer = null, iceQueue = [];

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
          width: { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { ideal: 15, max: 20 }
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
      params.encodings[0].maxBitrate = satOn() ? 180000 : 500000;
      params.encodings[0].maxFramerate = satOn() ? 10 : 15;
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
      }
      if (pc.connectionState === "failed" || pc.connectionState === "disconnected") endCall();
    };
  }

  async function startCall(audioOnly) {
    if (!currentConv || !currentPeer) return toast("Chwazi yon konvèsasyon");
    if (pc) return;
    callConv = Number(currentConv);
    const wantVideo = !audioOnly;
    $("videoOverlay").hidden = false;
    $("callStat").textContent = wantVideo ? "Ap limen kamera…" : "Ap mande mikwo…";
    try {
      localStream = await openMedia(wantVideo);
      const hasVideo = localStream.getVideoTracks().length > 0;
      attachVideo("localVid", localStream);
      $("callStat").textContent = hasVideo ? "Ap rele an videyo…" : "Ap rele an odyo…";
      await wirePc();
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await limitVideoBitrate();
      send({ type: "callOffer", convId: callConv, offer: pc.localDescription.toJSON(), audioOnly: !hasVideo });
      startRing(true);
    } catch (err) {
      toast("Mikwo/kamera pa disponib. Otorize yo nan navigatè a.");
      endCall();
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
  async function askNotify() {
    if (!("Notification" in window) || Notification.permission !== "default") return;
    try { await Notification.requestPermission(); } catch {}
  }
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
  $("hangBtn").onclick = endCall;
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
  $("callBtn").onclick = () => startCall(false);
  $("audioBtn").onclick = () => startCall(true);
})();
