(function(){
"use strict";
const $ = id => document.getElementById(id);
const STR = {
  kr: {connecting:"Ap konekte…",connected:"Konekte",offline:"Dekonekte",login:"Konekte",register:"Kreye kont",send:"Voye",type:"Ekri mesaj…",search:"Chache non oswa nimewo…",welcome:"Byenveni",typing:"ap ekri…",online:"anliy",offline2:"pa anliy",call:"Apèl videyo",audio:"Apèl odyo",loading:"Tann…"},
  fr: {connecting:"Connexion…",connected:"Connecté",offline:"Déconnecté",login:"Se connecter",register:"Créer un compte",send:"Envoyer",type:"Écrire un message…",search:"Rechercher nom ou numéro…",welcome:"Bienvenue",typing:"écrit…",online:"en ligne",offline2:"hors ligne",call:"Appel vidéo",audio:"Appel audio",loading:"Attente…"}
);
let lang = localStorage.getItem("kontak_lang") || "kr";
const T = k => (STR[lang]&&STR[lang][k])||STR.kr[k]||k;

function toast(m, isErr){ const t=$("toast"); t.textContent=m; t.hidden=false; t.className=isErr?"err":""; clearTimeout(t._t); t._t=setTimeout(()=>t.hidden=true, isErr?6000:3500); }
function setLoading(btn, on){ if(!btn) return; if(on){ btn._txt=btn.textContent; btn.textContent=T("loading"); btn.disabled=true; } else { btn.textContent=btn._txt||btn.textContent; btn.disabled=false; } }
function applyLang(){
  $("tabLogin").textContent=T("login"); $("tabReg").textContent=T("register");
  $("loginBtn").textContent=T("login"); $("regBtn").textContent=T("register");
  $("msgInput").placeholder=T("type"); $("sendBtn").textContent=T("send");
  $("callBtn").textContent=T("call"); $("audioBtn").textContent=T("audio");
  $("searchInput").placeholder=T("search");
  $("langBtn").textContent=lang==="kr"?"FR":"KR";
}
$("langBtn").onclick=()=>{ lang=lang==="kr"?"fr":"kr"; localStorage.setItem("kontak_lang",lang); applyLang(); };
applyLang();

// High-contrast theme
const contrastBtn=$("contrastBtn");
if(contrastBtn){
  const hc=localStorage.getItem("kontak_hc")==="1";
  if(hc) document.body.classList.add("hc");
  contrastBtn.onclick=()=>{
    const on=!document.body.classList.contains("hc");
    document.body.classList.toggle("hc",on);
    localStorage.setItem("kontak_hc",on?"1":"0");
    toast(on?"Kontras wo aktif":"Kontras nòmal");
  };
}

$("tabLogin").onclick=()=>{ $("loginForm").hidden=false; $("regForm").hidden=true; $("tabLogin").className="grow"; $("tabReg").className="ghost grow"; };
$("tabReg").onclick=()=>{ $("loginForm").hidden=true; $("regForm").hidden=false; $("tabReg").className="grow"; $("tabLogin").className="ghost grow"; };

let ws = null, me = null, currentConv = null, currentPeer = null;
const outbox = JSON.parse(localStorage.getItem("kontak_outbox")||"[]");

function setBar(txt, bad){ $("connBar").textContent=txt; $("connBar").style.borderColor=bad?"var(--warn)":"var(--line)"; }

function connect(){
  setBar(T("connecting"));
  const proto = location.protocol==="https:"?"wss:":"ws:";
  ws = new WebSocket(proto+"//"+location.host+"/ws");
  ws.onopen = ()=>{
    setBar(T("connected"));
    const phone=localStorage.getItem("kontak_phone"), pass=localStorage.getItem("kontak_pass");
    if(phone&&pass) send({type:"login",phone,password:pass});
    else showAuth();
  };
  ws.onmessage = e => { try { onMsg(JSON.parse(e.data)); } catch(err){ console.error(err); } };
  ws.onclose = ()=>{ setBar(T("offline"),true); me=null; showAuth(true); setTimeout(connect,2000); };
  ws.onerror = ()=>{};
}

function send(obj){ if(ws&&ws.readyState===1) ws.send(JSON.stringify(obj)); }

function onMsg(o){
  if(!o||!o.type) return;
  if(o.type==="auth-ok"){ me=o.user; localStorage.setItem("kontak_phone",me.phone); afterAuth(); }
  else if(o.type==="error") toast(o.error,true);
  else if(o.type==="search-results") renderSearch(o.results);
  else if(o.type==="conversations") renderConvs(o.list);
  else if(o.type==="conversation") openChat(o.id);
  else if(o.type==="messages") renderMessages(o.messages);
  else if(o.type==="new-message") onNewMessage(o);
  else if(o.type==="typing") onTyping(o);
  else if(o.type==="callOffer") onIncomingCall(o);
  else if(o.type==="callAnswer") onCallAnswer(o);
  else if(o.type==="callIce") onRemoteIce(o);
  else if(o.type==="callDecline"||o.type==="callHangup") endCall();
  else if(o.type==="presence") onPresence(o);
}

function showAuth(){ $("authView").hidden=false; $("mainView").hidden=true; $("logoutBtn").hidden=true; }
function afterAuth(){
  $("authView").hidden=true; $("mainView").hidden=false; $("logoutBtn").hidden=false;
  toast(T("welcome")+" "+me.name+"!");
  send({type:"getConversations"});
  flushOutbox();
}

$("loginBtn").onclick=()=>{
  const p=$("loginPassInput").value; localStorage.setItem("kontak_pass",p);
  setLoading($("loginBtn"),true);
  send({type:"login",phone:$("loginPhoneInput").value,password:p});
  setTimeout(()=>setLoading($("loginBtn"),false),8000);
};
$("regBtn").onclick=()=>{
  const p=$("regPassInput").value;
  let name=$("regNameInput").value.trim();
  if(!name) name="Kontak "+($("regPhoneInput").value.replace(/\D/g,"").slice(-4)||"User");
  localStorage.setItem("kontak_pass",p);
  setLoading($("regBtn"),true);
  send({type:"register",name,phone:$("regPhoneInput").value,password:p});
  setTimeout(()=>setLoading($("regBtn"),false),8000);
};
$("logoutBtn").onclick=()=>{ localStorage.removeItem("kontak_phone"); localStorage.removeItem("kontak_pass"); location.reload(); };

let searchTimer;
$("searchInput").oninput=()=>{ clearTimeout(searchTimer); searchTimer=setTimeout(()=>{
  const q=$("searchInput").value.trim();
  if(q.length<1){ $("searchRes").innerHTML=""; return; }
  send({type:"search",q});
},300); };

function renderSearch(results){
  const el=$("searchRes"); el.innerHTML="";
  results.forEach(u=>{
    const d=document.createElement("div");
    d.className="conv";
    d.innerHTML=`<div class="avatar">${u.name[0].toUpperCase()}</div><div class="grow"><b>${u.name}</b><div class="prev">${u.phone}</div></div><span class="dot${u.online?" on":""}"></span>`;
    d.onclick=()=>{ send({type:"getOrCreateConversation",peerId:u.id}); currentPeer=u; el.innerHTML=""; $("searchInput").value=""; };
    el.appendChild(d);
  });
}

function renderConvs(list){
  const el=$("convList"); el.innerHTML="";
  list.forEach(c=>{
    const d=document.createElement("div");
    d.className="conv"+(currentConv===c.id?" active":"");
    d.innerHTML=`<div class="avatar">${(c.peer.name||"?")[0].toUpperCase()}</div><div class="grow"><b>${c.peer.name}</b><span class="dot${c.peer.online?" on":""}"></span><div class="prev">${c.lastBody||c.peer.phone||""}</div></div>`;
    d.onclick=()=>{ currentConv=c.id; currentPeer=c.peer; openChat(c.id); };
    el.appendChild(d);
  });
}

function openChat(convId){
  currentConv=convId;
  $("chatName").textContent=currentPeer?currentPeer.name:"—";
  $("chatSub").textContent=currentPeer?currentPeer.phone:"";
  $("chatOnline").className="dot"+(currentPeer&&currentPeer.online?" on":"");
  $("msgs").innerHTML="";
  send({type:"getMessages",convId});
  send({type:"getConversations"});
}

function renderMessages(list){
  const el=$("msgs");
  list.forEach(m=>{
    const d=document.createElement("div");
    d.className="msg"+(m.from===me.id?" me":"");
    d.textContent=m.body;
    el.appendChild(d);
  });
  el.scrollTop=el.scrollHeight;
}

function onNewMessage(o){
  if(o.convId===currentConv){
    const d=document.createElement("div");
    d.className="msg"+(o.message.from===me.id?" me":"");
    d.textContent=o.message.body;
    $("msgs").appendChild(d);
    $("msgs").scrollTop=$("msgs").scrollHeight;
  }
  send({type:"getConversations"});
}

function onPresence(o){
  if(currentPeer && currentPeer.id === o.userId){
    $("chatOnline").className = "dot" + (o.online ? " on" : "");
    currentPeer.online = o.online;
  }
  if(me) send({type:"getConversations"});
}

function onTyping(o){
  if(o.convId===currentConv){
    $("typingEl").textContent=o.fromName+" "+T("typing");
    clearTimeout($("typingEl").__t);
    $("typingEl").__t=setTimeout(()=>$("typingEl").textContent="",1500);
  }
}

$("msgInput").oninput=()=>{ if(currentConv) send({type:"typing",convId:currentConv}); };
$("sendBtn").onclick=sendMsg;
$("msgInput").onkeydown=e=>{ if(e.key==="Enter"&&!e.shiftKey){ e.preventDefault(); sendMsg(); } };

function sendMsg(){
  const body=$("msgInput").value.trim();
  if(!body||!currentConv) return;
  if(!navigator.onLine || !ws || ws.readyState!==1){
    outbox.push({convId:currentConv,body});
    localStorage.setItem("kontak_outbox",JSON.stringify(outbox));
    toast("ap tann rezo…");
    $("msgInput").value="";
    return;
  }
  send({type:"sendMessage",convId:currentConv,body});
  $("msgInput").value="";
}

function flushOutbox(){
  while(outbox.length && ws && ws.readyState===1){
    const m=outbox.shift();
    send({type:"sendMessage",...m});
  }
  localStorage.setItem("kontak_outbox",JSON.stringify(outbox));
}
window.addEventListener("online",flushOutbox);

function satOn(){ return localStorage.getItem("kontak_sat")==="1"; }
$("satBtn").textContent=satOn()?"SAT: ON":"SAT: OFF";
$("satBtn").onclick=()=>{
  const on=!satOn();
  localStorage.setItem("kontak_sat",on?"1":"0");
  $("satBtn").textContent=on?"SAT: ON":"SAT: OFF";
  toast(on?"Mòd SAT: odyo ~16 kbps (rezo fèb)":"Mòd nòmal");
);

$("turnBtn").onclick=()=>{
  $("turnUrlInput").value=localStorage.getItem("kontak_turn_url")||"";
  $("turnUserInput").value=localStorage.getItem("kontak_turn_user")||"";
  $("turnPassInput").value=localStorage.getItem("kontak_turn_pass")||"";
  $("turnModal").hidden=false;
);
$("turnCloseBtn").onclick=()=>$("turnModal").hidden=true;
$("turnSaveBtn").onclick=()=>{
  localStorage.setItem("kontak_turn_url",$("turnUrlInput").value.trim());
  localStorage.setItem("kontak_turn_user",$("turnUserInput").value.trim());
  localStorage.setItem("kontak_turn_pass",$("turnPassInput").value.trim());
  $("turnModal").hidden=true;
  toast("TURN sove");
);

function iceServers(){
  const servers=[{urls:"stun:stun.l.google.com:19302"}];
  const url=localStorage.getItem("kontak_turn_url");
  if(url) servers.push({urls:url,username:localStorage.getItem("kontak_turn_user")||"",credential:localStorage.getItem("kontak_turn_pass")||""});
  return servers;
}

let pc=null, localStream=null, callConv=null, pendingOffer=null, iceQueue=[];

function flushIce(){
  if(!pc || !pc.remoteDescription) return;
  while(iceQueue.length){
    const c = iceQueue.shift();
    pc.addIceCandidate(c).catch(()=>{});
  }
}

async function startCall(audioOnly){
  if(!currentConv||!currentPeer) return toast("Chwazi yon konvèsasyon");
  if(pc) return;
  callConv=currentConv;
  const forceAudio = audioOnly || satOn();
  $("videoOverlay").hidden=false;
  $("callStat").textContent=forceAudio ? "Ap rele (odyo / SAT)…" : "Ap rele…";
  try{
    const constraints = forceAudio
      ? { audio: { echoCancellation: true, noiseSuppression: true }, video: false }
      : { audio: { echoCancellation: true, noiseSuppression: true }, video: { width: { ideal: 320 }, height: { ideal: 180 }, frameRate: { ideal: 10 } } };
    localStream = await navigator.mediaDevices.getUserMedia(constraints);
    $("localVid").srcObject = localStream;
    pc = new RTCPeerConnection({ iceServers: iceServers() });
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
    pc.onicecandidate = e => { if(e.candidate) send({type:"callIce",convId:callConv,candidate:e.candidate}); };
    pc.ontrack = e => { $("remoteVid").srcObject = e.streams[0]; };
    pc.onconnectionstatechange = () => {
      if(pc.connectionState==="connected") $("callStat").textContent="Konekte";
      if(pc.connectionState==="failed"||pc.connectionState==="disconnected") endCall();
    };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    send({type:"callOffer",convId:callConv,offer,audioOnly:forceAudio});
  }catch(err){
    toast("Mikwo/kamera pa disponib");
    endCall();
  }
}

function onIncomingCall(o){
  if(o.from===me.id) return;
  pendingOffer=o;
  $("incomingFrom").textContent=o.fromName||o.from;
  $("incoming").hidden=false;
}

$("acceptBtn").onclick=async()=>{
  if(!pendingOffer) return;
  const o=pendingOffer; pendingOffer=null;
  $("incoming").hidden=true;
  callConv=o.convId;
  const forceAudio = o.audioOnly || satOn();
  $("videoOverlay").hidden=false;
  $("callStat").textContent=forceAudio?"Ap reponn (odyo)…":"Ap reponn…";
  try{
    const constraints = forceAudio
      ? { audio: { echoCancellation: true, noiseSuppression: true }, video: false }
      : { audio: { echoCancellation: true, noiseSuppression: true }, video: { width: { ideal: 320 }, height: { ideal: 180 }, frameRate: { ideal: 10 } } };
    localStream = await navigator.mediaDevices.getUserMedia(constraints);
    $("localVid").srcObject = localStream;
    pc = new RTCPeerConnection({ iceServers: iceServers() });
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
    pc.onicecandidate = e => { if(e.candidate) send({type:"callIce",convId:callConv,candidate:e.candidate}); };
    pc.ontrack = e => { $("remoteVid").srcObject = e.streams[0]; };
    pc.onconnectionstatechange = () => {
      if(pc.connectionState==="connected") $("callStat").textContent="Konekte";
      if(pc.connectionState==="failed"||pc.connectionState==="disconnected") endCall();
    };
    await pc.setRemoteDescription(new RTCSessionDescription(o.off));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    send({type:"callAnswer",convId:callConv,answer});
    flushIce();
  }catch(err){
    toast("Mikwo/kamera pa disponib");
    endCall();
  }
);

$("declineBtn").onclick=()=>{
  if(pendingOffer){ send({type:"callDecline",convId:pendingOffer.convId}); pendingOffer=null; }
  $("incoming").hidden=true;
);

function onCallAnswer(o){
  if(!pc) return;
  pc.setRemoteDescription(new RTCSessionDescription(o.answer)).then(flushIce).catch(()=>{});
}

function onRemoteIce(o){
  if(!o.candidate) return;
  const c = new RTCIceCandidate(o.candidate);
  if(!pc || !pc.remoteDescription) iceQueue.push(c);
  else pc.addIceCandidate(c).catch(()=>{});
}

function endCall(){
  if(pc){ pc.close(); pc=null; }
  if(localStream){ localStream.getTracks().forEach(t=>t.stop()); localStream=null; }
  $("videoOverlay").hidden=true;
  $("remoteVid").srcObject=null; $("localVid").srcObject=null;
  if(callConv) send({type:"callHangup",convId:callConv});
  callConv=null; iceQueue=[];
}
$("hangBtn").onclick=endCall;
$("muteBtn").onclick=()=>{
  if(!localStream) return;
  const t=localStream.getAudioTracks()[0]; if(!t) return;
  t.enabled=!t.enabled;
  $("muteBtn").textContent=t.enabled?"Mikwo: ON":"Mikwo: OFF";
);
$("camBtn").onclick=()=>{
  if(!localStream) return;
  const t=localStream.getVideoTracks()[0]; if(!t) return;
  t.enabled=!t.enabled;
  $("camBtn").textContent=t.enabled?"Kamera: ON":"Kamera: OFF";
);

$("callBtn").onclick=()=>startCall(false);
$("audioBtn").onclick=()=>startCall(true);

connect();
})();