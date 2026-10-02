// ========== AUDIO ==========
const CH={bell:{freq:[880,1108,1320],type:"sine",decay:.8},ping:{freq:[1200],type:"sine",decay:.3},buzz:{freq:[220,223],type:"sawtooth",decay:.5},chord:{freq:[523,659,784],type:"triangle",decay:1},alarm:{freq:[600,900],type:"square",decay:.6}};
const CHL={bell:"Bell",ping:"Ping",buzz:"Buzz",chord:"Chord",alarm:"Alarm"};
const TARG_LBL={pomo:"Pomodoro",quick:"Quick",sw:"Stopwatch"};
let _audioCtx=null;
function getAudioCtx(){if(!_audioCtx||_audioCtx.state==='closed')_audioCtx=new(window.AudioContext||window.webkitAudioContext)();if(_audioCtx.state==='suspended')_audioCtx.resume();return _audioCtx}

// Prime the AudioContext on the first user gesture (any pointer/keyboard/touch
// hit on the document). Chrome/Safari leave the context in a 'suspended' state
// until a gesture explicitly unlocks it — without this, auto-started focus or
// break phases (autoWork/autoBreak) silently fail to chime because the resume
// inside getAudioCtx() runs outside a gesture. Single-shot: removed after first
// successful prime.
// Not single-shot: iOS re-suspends the context every time the app goes to the
// background and refuses resume() outside user activation, so the listeners
// stay armed and re-prime on any later gesture while the context isn't
// running. The check is a cheap state read, so this costs nothing once primed.
let _hadUserGesture=false;        // fallback where navigator.userActivation is missing
let _audioRescheduleOnPrime=false; // a schedule was skipped because the clock wasn't live
/**
 * Can oscillators be scheduled against the AudioContext clock right now?
 * Before the first user gesture the context is suspended with currentTime
 * frozen at 0 (autoplay policy), so a chime scheduled at `0 + remaining`
 * would sound `remaining` seconds after the first click instead of at phase
 * end — and audioScheduled=true made the completion path skip its fallback
 * chime. After a gesture a suspended context is only moments from running.
 */
function _audioClockLive(){
  try{
    const x=getAudioCtx();
    if(!x||x.state==='running')return true;
    const ua=(typeof navigator!=='undefined')?navigator.userActivation:null;
    if(ua&&typeof ua.hasBeenActive==='boolean')return ua.hasBeenActive;
    return _hadUserGesture;
  }catch(_){return true;}
}
/** First gesture after a boot that skipped scheduling: put the chimes back. */
function _rescheduleAudioAfterPrime(){
  if(!_audioRescheduleOnPrime)return;
  _audioRescheduleOnPrime=false;
  try{
    if(typeof running!=='undefined'&&running&&typeof schedulePhaseAudio==='function'&&!audioScheduled)schedulePhaseAudio();
    if(typeof quickTimers!=='undefined'&&Array.isArray(quickTimers)&&typeof scheduleQtAudio==='function'){
      quickTimers.forEach(qt=>{ if(qt&&qt.running&&!(qt._nodes&&qt._nodes.length))scheduleQtAudio(qt); });
    }
  }catch(_){}
}
(function(){
  if(typeof document === 'undefined') return;
  const prime = () => {
    _hadUserGesture=true;
    try{
      if(_audioCtx && _audioCtx.state === 'running'){ _rescheduleAudioAfterPrime(); return; }
      const x = getAudioCtx();
      if(x && x.state !== 'running' && x.state !== 'closed' && typeof x.resume === 'function'){
        x.resume().then(()=>{ _rescheduleAudioAfterPrime(); }).catch(()=>{});
      } else if(x && x.state === 'running'){
        _rescheduleAudioAfterPrime();
      }
    }catch(_){}
    // A keepalive element whose autoplay was refused before any gesture gets
    // its second chance here — same reasoning as the AudioContext resume.
    try{
      if(_keepaliveEl && _keepaliveEl.paused) _keepaliveEl.play().catch(()=>{});
    }catch(_){}
  };
  document.addEventListener('pointerdown', prime, true);
  document.addEventListener('keydown',     prime, true);
  document.addEventListener('touchstart',  prime, true);
})();

// ========== KEEPALIVE: prevents browser from suspending audio when tab is in background ==========
// Technique: play a silent audio tone continuously. Browsers keep the tab "active" as long as
// audio is playing, which means timers, scheduled audio, and notifications continue firing
// even when the tab is backgrounded or minimized. This is how Pomofocus, Forest, etc. work.
let _keepaliveNode=null,_keepaliveGain=null;
// Chrome only treats a tab as "playing audio" when the rendered output rises
// above its silence threshold, -72.25 dBFS (an amplitude of 1/4096 ≈ 0.00024;
// see media/audio/audio_stream_monitor.cc). The old keepalive ran at 0.0001
// (≈ -80 dBFS) — below the line — so the browser classified the tab as silent:
// no media session, background timer throttling / page freezing applied as
// usual, the AudioContext was suspended on screen-lock, and every pre-scheduled
// chime silently vanished. 0.004 at 20 Hz is ≈ -51 dBFS (20 dB of margin) yet
// still inaudible on real hardware: phone speakers can't reproduce 20 Hz at
// all and headphones sit far below the hearing threshold at that level.
const KEEPALIVE_GAIN=0.004;
const KEEPALIVE_FREQ_HZ=20;
// ── Media-element keepalive ───────────────────────────────────────────────
// The oscillator above signals "this tab makes sound" to Chrome's audio
// stream monitor, which is enough to dodge desktop tab throttling. It is NOT
// enough on mobile: what keeps an app alive in the background there is an
// active *media session*, and only a real media element creates one. iOS in
// particular suspends a bare AudioContext the moment the app backgrounds and
// refuses resume() outside user activation, which is why the chime "works
// periodically" today.
//
// So we also loop a genuine (near-silent) WAV through an <audio> element.
// That gives the OS something to hold an audio focus on, keeps the page off
// the freeze list far longer, and makes the MediaMetadata set below actually
// appear on the lock screen. It is belt-and-braces with the alarm scheduler
// in js/alarms.js — that one is what guarantees delivery; this one keeps the
// in-app chime and tick running for as long as the OS will allow.
let _keepaliveEl = null;

/**
 * A 1-second mono 8 kHz WAV at a very low DC-free amplitude. Built at runtime
 * so no binary asset has to ship (and so it can't go missing from the
 * precache). Amplitude matches KEEPALIVE_GAIN's reasoning: above Chrome's
 * -72.25 dBFS silence threshold, far below audibility.
 */
function _buildKeepaliveWavUrl(){
  const rate = 8000, seconds = 1, n = rate * seconds;
  const bytes = 44 + n * 2;
  const buf = new ArrayBuffer(bytes);
  const v = new DataView(buf);
  const ascii = (off, str) => { for(let i=0;i<str.length;i++) v.setUint8(off+i, str.charCodeAt(i)); };
  ascii(0,'RIFF');  v.setUint32(4, bytes-8, true);
  ascii(8,'WAVE');  ascii(12,'fmt ');
  v.setUint32(16,16,true); v.setUint16(20,1,true); v.setUint16(22,1,true);
  v.setUint32(24,rate,true); v.setUint32(28,rate*2,true);
  v.setUint16(32,2,true); v.setUint16(34,16,true);
  ascii(36,'data'); v.setUint32(40, n*2, true);
  // 20 Hz sine at ~-51 dBFS, same as the oscillator. A pure DC offset or a
  // run of zeros would read as silence and defeat the whole point.
  const amp = Math.round(32767 * KEEPALIVE_GAIN);
  for(let i=0;i<n;i++){
    v.setInt16(44 + i*2, Math.round(amp * Math.sin(2*Math.PI*KEEPALIVE_FREQ_HZ*i/rate)), true);
  }
  const blob = new Blob([buf], { type: 'audio/wav' });
  return URL.createObjectURL(blob);
}

function _startMediaKeepalive(){
  if(_keepaliveEl) { try{ _keepaliveEl.play().catch(()=>{}); }catch(_){} return; }
  try{
    const el = document.createElement('audio');
    el.loop = true;
    el.preload = 'auto';
    // playsinline + muted=false: a muted element does NOT take an audio focus,
    // which is exactly the property we need, so it must stay unmuted.
    el.setAttribute('playsinline', '');
    el.volume = 1;
    el.src = _buildKeepaliveWavUrl();
    // Keep it out of the a11y tree and off screen; it is pure plumbing.
    el.setAttribute('aria-hidden', 'true');
    el.style.cssText = 'position:absolute;width:0;height:0;opacity:0;pointer-events:none';
    document.body.appendChild(el);
    _keepaliveEl = el;
    const p = el.play();
    if(p && p.catch) p.catch(()=>{
      // Autoplay refused (no user activation yet). The gesture primer at the
      // top of this file re-primes the AudioContext; retry playback there too.
    });
  }catch(e){ _keepaliveEl = null; }
}

function _stopMediaKeepalive(){
  if(!_keepaliveEl) return;
  try{
    _keepaliveEl.pause();
    if(_keepaliveEl.src && _keepaliveEl.src.startsWith('blob:')) URL.revokeObjectURL(_keepaliveEl.src);
    _keepaliveEl.remove();
  }catch(_){}
  _keepaliveEl = null;
}

function startKeepalive(){
  if(_keepaliveNode)return;
  try{
    const x=getAudioCtx();
    _keepaliveNode=x.createOscillator();
    _keepaliveGain=x.createGain();
    _keepaliveNode.type='sine';
    _keepaliveNode.frequency.value=KEEPALIVE_FREQ_HZ;
    _keepaliveGain.gain.value=KEEPALIVE_GAIN;
    _keepaliveNode.connect(_keepaliveGain);
    _keepaliveGain.connect(x.destination);
    _keepaliveNode.start();
  }catch(e){}
  _startMediaKeepalive();
  _acquireWakeLock();
  if('mediaSession' in navigator){
    try{
      navigator.mediaSession.metadata=new MediaMetadata({
        title:'Odta Focus Timer',
        artist:'Pomodoro session in progress',
        album:'Odta'
      });
      navigator.mediaSession.playbackState='playing';
      // Lock-screen / headphone controls act on whatever is actually running.
      // 'play' only resumes a paused Pomodoro — it must never start a fresh
      // phase the user didn't ask for while a quick timer or stopwatch runs.
      navigator.mediaSession.setActionHandler('pause',()=>{
        try{
          if(running){ pauseTimer(); return; }
          if(typeof quickTimers!=='undefined'&&quickTimers.some(qt=>qt.running)){ quickTimers.filter(qt=>qt.running).forEach(qt=>toggleQuickTimer(qt.id)); return; }
          if(typeof swRunning!=='undefined'&&swRunning&&typeof swToggle==='function') swToggle();
        }catch(e){}
      });
      navigator.mediaSession.setActionHandler('play',()=>{
        try{ if(!running&&typeof getTimerState==='function'&&getTimerState()==='paused') resumeTimer(); }catch(e){}
      });
    }catch(e){}
  }
  updateBgAudioStatus();
}
function stopKeepalive(){
  try{if(_keepaliveNode){_keepaliveNode.stop();_keepaliveNode=null;_keepaliveGain=null}}catch(e){}
  _stopMediaKeepalive();
  _wakeLockWanted=false;
  if(_wakeLock){try{_wakeLock.release()}catch(e){}_wakeLock=null}
  if('mediaSession' in navigator){
    try{
      navigator.mediaSession.playbackState='none';
      navigator.mediaSession.setActionHandler('pause',null);
      navigator.mediaSession.setActionHandler('play',null);
      navigator.mediaSession.metadata=null;
    }catch(e){}
  }
  updateBgAudioStatus();
}
function updateBgAudioStatus(){
  const el=gid('bgAudioStatus');if(!el)return;
  if(_keepaliveNode){
    const media = _keepaliveEl && !_keepaliveEl.paused;
    const scheduled = (window.OdtaAlarms && window.OdtaAlarms.supportsTriggers())
      ? ' · alarms scheduled with the OS' : ' · alarms delivered by the service worker';
    el.textContent = '● Active — background OK' + (media ? '' : ' (media keepalive blocked — tap anywhere once)') + scheduled;
    el.style.color='var(--success)';
  }else{
    el.textContent='○ Idle — starts with timer';
    el.style.color='var(--text-3)';
  }
}
let _wakeLock=null;
// The request is async: a stop that lands before it resolves used to leave
// the lock held forever (screen never sleeping with no timer running).
let _wakeLockWanted=false;

/**
 * Acquire the Screen Wake Lock. Extracted so it can be called both from
 * startKeepalive() and from the visibilitychange handler (the browser
 * automatically releases the lock when a page becomes hidden, so we must
 * re-acquire it every time the page becomes visible again while a timer
 * is active).
 */
function _acquireWakeLock(){
  _wakeLockWanted=true;
  if(_wakeLock) return; // already held
  if(!('wakeLock' in navigator)) return;
  navigator.wakeLock.request('screen').then(l=>{
    if(!_wakeLockWanted||_wakeLock){ try{l.release()}catch(e){} return; } // stopped (or re-acquired) meanwhile
    _wakeLock=l;
    // When the OS releases the lock (e.g. page hidden), null it out so
    // re-acquire on visibilitychange works correctly.
    l.addEventListener('release', ()=>{ if(_wakeLock===l) _wakeLock=null; });
  }).catch(()=>{});
}

function playChime(t){try{const x=getAudioCtx(),c=CH[t]||CH.bell;c.freq.forEach((f,i)=>{const o=x.createOscillator(),g=x.createGain();o.type=c.type;o.frequency.setValueAtTime(f,x.currentTime);g.gain.setValueAtTime(.25,x.currentTime);g.gain.exponentialRampToValueAtTime(.001,x.currentTime+c.decay);o.connect(g);g.connect(x.destination);o.start(x.currentTime+i*.05);o.stop(x.currentTime+c.decay+.1)})}catch(e){}}
function playTransition(){try{const x=getAudioCtx();[0,.12,.24,.36].forEach((d,i)=>{const fr=[523,659,784,1047][i],o=x.createOscillator(),g=x.createGain();o.type="sine";o.frequency.setValueAtTime(fr,x.currentTime+d);g.gain.setValueAtTime(.3,x.currentTime+d);g.gain.exponentialRampToValueAtTime(.001,x.currentTime+d+.5);o.connect(g);g.connect(x.destination);o.start(x.currentTime+d);o.stop(x.currentTime+d+.6)})}catch(e){}}
function playBreakEnd(){try{const x=getAudioCtx();[0,.1,.2].forEach((d,i)=>{const fr=[784,659,523][i],o=x.createOscillator(),g=x.createGain();o.type="triangle";o.frequency.setValueAtTime(fr,x.currentTime+d);g.gain.setValueAtTime(.25,x.currentTime+d);g.gain.exponentialRampToValueAtTime(.001,x.currentTime+d+.4);o.connect(g);g.connect(x.destination);o.start(x.currentTime+d);o.stop(x.currentTime+d+.5)})}catch(e){}}

// ========== SCHEDULED AUDIO (fires reliably in background tabs) ==========
// Web Audio scheduling uses the audio clock, which isn't throttled like setInterval.
// We pre-schedule chimes at phase/timer start so they play even when the tab is hidden.
let scheduledAudio=[],audioScheduled=false;

function scheduleAudioChime(delaySec,type){
  if(!cfg.sound||delaySec<=0)return;
  try{
    const x=getAudioCtx(),base=x.currentTime+delaySec,c=CH[type]||CH.bell;
    c.freq.forEach((f,i)=>{
      const o=x.createOscillator(),g=x.createGain(),t=base+i*.05;
      o.type=c.type;o.frequency.setValueAtTime(f,t);
      g.gain.setValueAtTime(.25,t);g.gain.exponentialRampToValueAtTime(.001,t+c.decay);
      o.connect(g);g.connect(x.destination);
      o.start(t);o.stop(t+c.decay+.1);
      scheduledAudio.push(o);
    });
  }catch(e){}
}

function scheduleTransitionAudio(delaySec){
  if(!cfg.sound||delaySec<=0)return;
  try{
    const x=getAudioCtx(),base=x.currentTime+delaySec;
    [0,.12,.24,.36].forEach((d,i)=>{
      const fr=[523,659,784,1047][i],o=x.createOscillator(),g=x.createGain();
      o.type="sine";o.frequency.setValueAtTime(fr,base+d);
      g.gain.setValueAtTime(.3,base+d);g.gain.exponentialRampToValueAtTime(.001,base+d+.5);
      o.connect(g);g.connect(x.destination);
      o.start(base+d);o.stop(base+d+.6);
      scheduledAudio.push(o);
    });
  }catch(e){}
}

function scheduleBreakEndAudio(delaySec){
  if(!cfg.sound||delaySec<=0)return;
  try{
    const x=getAudioCtx(),base=x.currentTime+delaySec;
    [0,.1,.2].forEach((d,i)=>{
      const fr=[784,659,523][i],o=x.createOscillator(),g=x.createGain();
      o.type="triangle";o.frequency.setValueAtTime(fr,base+d);
      g.gain.setValueAtTime(.25,base+d);g.gain.exponentialRampToValueAtTime(.001,base+d+.4);
      o.connect(g);g.connect(x.destination);
      o.start(base+d);o.stop(base+d+.5);
      scheduledAudio.push(o);
    });
  }catch(e){}
}

function cancelScheduledAudio(){
  scheduledAudio.forEach(o=>{try{o.stop(0)}catch(e){}});
  scheduledAudio=[];audioScheduled=false;
}

// ========== AUDIO-CLOCK STALL DETECTION ==========
// Pre-scheduled oscillators fire on the AudioContext clock. When the OS
// suspends that context (iOS always does on background; Android/desktop do
// once the tab is considered silent or frozen) the clock stops while wall
// time keeps going. On resume, every scheduled chime is still "in the
// future" on the audio clock, so it plays late — minutes or hours after the
// timer actually ended — and the completion path skips its fallback chime
// because it believes the scheduled one already played. We snapshot both
// clocks when the page hides and compare on wake; a gap means the scheduled
// audio is stale and must be replaced (see _reconcileTimerAfterWake).
let _audioClockRef=null; // { wall: ms epoch, audio: AudioContext seconds }
const AUDIO_STALL_TOLERANCE_SEC=1.5;
function _markAudioClock(){
  try{
    if(!_audioCtx){ _audioClockRef=null; return; }
    _audioClockRef={ wall: Date.now(), audio: _audioCtx.currentTime };
  }catch(e){ _audioClockRef=null; }
}
/** Seconds the audio clock fell behind wall time since the last mark (0 when in sync / unknown). */
function audioClockStalledSec(){
  try{
    if(!_audioCtx||!_audioClockRef) return 0;
    const wall=(Date.now()-_audioClockRef.wall)/1000;
    const aud=_audioCtx.currentTime-_audioClockRef.audio;
    if(!Number.isFinite(wall)||!Number.isFinite(aud)) return 0;
    return Math.max(0, wall-aud);
  }catch(e){ return 0; }
}
/** True when chimes scheduled before the last mark can no longer be trusted to have played on time. */
function scheduledAudioLost(){ return audioClockStalledSec()>AUDIO_STALL_TOLERANCE_SEC; }
if(typeof window!=='undefined'){ window.audioClockStalledSec=audioClockStalledSec; window.scheduledAudioLost=scheduledAudioLost; }

// Bounded lookahead pre-scheduler for the (open-ended) stopwatch.
// startElapsedSec = current stopwatch elapsed seconds at scheduling time.
// Caps at min(SW_LOOKAHEAD_SEC, SW_MAX_FIRES_PER_INTERVAL) per interval.
const SW_LOOKAHEAD_SEC=3600,SW_MAX_FIRES_PER_INTERVAL=200;
/**
 * @returns {number|null} elapsed-seconds horizon up to which every sw-target
 *   interval has scheduled chimes (null when nothing was scheduled). swTick
 *   re-arms when the stopwatch crosses it — previously chimes simply stopped
 *   after the lookahead because the played nodes stayed in `nodesOut` and
 *   suppressed the runtime fallback.
 */
function scheduleSwIntervalChimes(startElapsedSec,intervalsList,fireCounts,nodesOut){
  if(!cfg.sound)return null;
  let horizon=null;
  try{
    const x=getAudioCtx();
    intervalsList.forEach(iv=>{
      if(iv.intervalSec<=0)return;
      if((iv.target||'pomo')!=='sw')return;
      const c=CH[iv.chime]||CH.bell;
      const alreadyFired=(fireCounts&&fireCounts[iv.id])||0;
      let scheduled=0,lastFireAt=null;
      for(let n=alreadyFired+1;scheduled<SW_MAX_FIRES_PER_INTERVAL;n++){
        const fireAt=n*iv.intervalSec;
        const delay=fireAt-startElapsedSec;
        if(delay<=0)continue;
        if(delay>SW_LOOKAHEAD_SEC)break;
        const base=x.currentTime+delay;
        c.freq.forEach((f,i)=>{
          const o=x.createOscillator(),g=x.createGain(),t=base+i*.05;
          o.type=c.type;o.frequency.setValueAtTime(f,t);
          g.gain.setValueAtTime(.25,t);g.gain.exponentialRampToValueAtTime(.001,t+c.decay);
          o.connect(g);g.connect(x.destination);
          o.start(t);o.stop(t+c.decay+.1);
          nodesOut.push(o);
        });
        scheduled++;lastFireAt=fireAt;
      }
      if(lastFireAt!=null) horizon=(horizon==null)?lastFireAt:Math.min(horizon,lastFireAt);
    });
  }catch(e){}
  return horizon;
}
function cancelSwIntervalChimes(nodesOut){
  if(!nodesOut)return;
  nodesOut.forEach(o=>{try{o.stop(0)}catch(e){}});
  nodesOut.length=0;
}

function schedulePhaseAudio(){
  cancelScheduledAudio();
  if(!cfg.sound)return;
  if(!_audioClockLive()){ audioScheduled=false; _audioRescheduleOnPrime=true; return; }
  // Schedule phase-end completion chime
  if(phase==='work')scheduleTransitionAudio(remaining);
  else scheduleBreakEndAudio(remaining);
  // Schedule all remaining interval chimes (Pomodoro-targeted only)
  intervals.forEach(iv=>{
    if(iv.intervalSec<=0)return;
    if((iv.target||'pomo')!=='pomo')return;
    const totalEl=totalDuration-remaining;
    const alreadyFired=fireCounts[iv.id]||0;
    for(let n=alreadyFired+1;n*iv.intervalSec<=totalDuration;n++){
      const delay=n*iv.intervalSec-totalEl;
      if(delay>0&&delay<=remaining)scheduleAudioChime(delay,iv.chime);
    }
  });
  audioScheduled=true;
}

// ========== NOTIFICATIONS (fire when tab hidden/minimized) ==========
// iOS Safari pre-16.4 has no Notification API; iOS 16.4+ supports it but ONLY
// when the page is installed to the Home Screen (standalone PWA). Detect both
// cases so the settings UI can explain *why* the toggle does nothing instead
// of looking broken.
function notifSupportLevel(){
  if(!('Notification' in window)) return 'unsupported';
  // iOS-family detection (iPhone/iPad and iPadOS-as-MacIntel-with-touch).
  const ua = navigator.userAgent || '';
  const isIOS = /iPad|iPhone|iPod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  if(isIOS && !isStandalone) return 'ios-needs-install';
  return 'ok';
}
function notifPermissionState(){
  if(!('Notification' in window)) return 'unsupported';
  return Notification.permission; // 'default' | 'granted' | 'denied'
}
async function reqNotifPerm(){
  // Returns the post-prompt permission so callers can update UI without a
  // round-trip through localStorage. Wrapped because some browsers throw
  // synchronously when called outside a user gesture.
  if(!('Notification' in window)) return 'unsupported';
  if(Notification.permission !== 'default') return Notification.permission;
  try{
    const result = await Notification.requestPermission();
    return result || Notification.permission;
  }catch(e){
    return Notification.permission;
  }
}
// Render a one-line status under the Notifications toggle so users can see
// *why* the toggle does (or doesn't) work. Without this, a flipped-on toggle
// in a denied/unsupported state looks like the app is broken. Called from
// toggleOpt and from settings panel open.
function renderNotifStatus(){
  const row = document.getElementById('notifStatusRow');
  const host = document.getElementById('notifStatus');
  if(!row || !host) return;
  host.replaceChildren();
  // Toggle off → don't surface anything; the user has disabled it explicitly.
  if(typeof cfg !== 'undefined' && cfg && cfg.notif === false){ row.hidden = true; return; }
  const support = notifSupportLevel();
  const perm = notifPermissionState();
  let msg = '', cls = 'notif-status notif-status--ok', cta = null;
  if(support === 'unsupported'){
    msg = 'Browser does not support notifications.'; cls = 'notif-status notif-status--err';
  } else if(support === 'ios-needs-install'){
    msg = 'iOS: install to Home Screen first (Share → Add to Home Screen) — Safari blocks notifications on un-installed pages.';
    cls = 'notif-status notif-status--warn';
  } else if(perm === 'denied'){
    msg = 'Permission denied. Re-enable in your browser site settings (lock icon → Notifications).';
    cls = 'notif-status notif-status--err';
  } else if(perm === 'default'){
    msg = 'Permission not yet granted.';
    cls = 'notif-status notif-status--warn';
    cta = { label: 'Allow notifications', run: async () => {
      const next = await reqNotifPerm();
      renderNotifStatus();
      if(next === 'granted' && typeof showExportToast === 'function'){
        showExportToast('Notifications enabled.');
      }
    }};
  } else {
    msg = 'Notifications enabled.';
  }
  row.hidden = false;
  host.className = cls;
  const t = document.createElement('span');
  t.textContent = msg;
  host.appendChild(t);
  if(cta){
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'notif-status-btn';
    b.textContent = cta.label;
    b.onclick = cta.run;
    host.appendChild(b);
  }
}
if(typeof window !== 'undefined') window.renderNotifStatus = renderNotifStatus;

function notify(title, body, opts){
  if(cfg.notif===false)return;
  if(!('Notification' in window))return;
  if(Notification.permission!=='granted')return;
  const o = opts || {};
  const mainThreadFallback = () => {
    try{
      const n=new Notification(title,{body,tag:o.tag||'odtaulai',renotify:true,silent:false,data:o.data||{}});
      setTimeout(()=>{try{n.close()}catch(e){}},8000);
    }catch(e){}
  };
  // ── Prefer ServiceWorker.showNotification() ──
  // This fires even when the tab is frozen / the app is backgrounded on
  // mobile, unlike main-thread `new Notification()` which requires an
  // active page context.
  // Gate on an ACTIVE controller, not the mere existence of the API: on
  // file:// the API object exists but pwa.js never registers a worker, so
  // navigator.serviceWorker.ready never resolves and the early return below
  // would strand the main-thread fallback this branch is supposed to defer to.
  if('serviceWorker' in navigator && navigator.serviceWorker.controller){
    navigator.serviceWorker.ready.then(reg => {
      if(reg && reg.showNotification){
        // Only fall back if the SW refuses; a resolved promise means it was
        // shown, so the two paths never double-fire.
        return reg.showNotification(title, {
          body: body || '',
          tag: o.tag || 'odtaulai',
          renotify: true,
          icon: './icons/icon-192.png',
          badge: './icons/icon-192.png',
          silent: false,
          requireInteraction: !!o.requireInteraction,
          data: o.data || {},
        }).catch(mainThreadFallback);
      }
      mainThreadFallback();
    }).catch(mainThreadFallback);
    return;
  }
  // ── Fallback: main-thread Notification (file:// or no SW) ──
  mainThreadFallback();
}

// ========== BACKGROUND RESILIENCE ==========
// Mobile browsers aggressively suspend tabs. This section handles:
//   1. Re-acquiring Wake Lock when page becomes visible (OS releases it on hide)
//   2. Resuming AudioContext that the browser suspended while hidden
//   3. Proactively resuming AudioContext BEFORE going hidden (catches the
//      race where the browser suspends it moments after the tab hides)
//   4. Catching up on missed reminder checks after waking from background

document.addEventListener('visibilitychange',()=>{
  if(document.hidden){
    // ── Going to background ──
    // Snapshot wall vs audio clock so the wake path can tell whether the
    // context kept running (chimes played on time) or was suspended
    // (chimes are stale and must be replayed / rescheduled).
    _markAudioClock();
    // Proactively resume the AudioContext right as we go hidden so any
    // pre-scheduled oscillator nodes keep playing. Some browsers suspend
    // the context within seconds of hiding the page; calling resume()
    // here extends the window long enough for the keepalive oscillator
    // to signal the browser that audio is actively in use.
    if(_audioCtx&&_audioCtx.state==='suspended'){
      try{_audioCtx.resume()}catch(e){}
    }
  }else{
    // ── Coming back to foreground ──
    // Measure the stall BEFORE resuming: resume() restarts the audio clock
    // and the gap is what tells us the scheduled chimes were lost.
    const stalledSec=audioClockStalledSec();
    // Resume AudioContext (may have been suspended by OS while hidden)
    if(_audioCtx&&_audioCtx.state!=='running'&&_audioCtx.state!=='closed'){
      try{const p=_audioCtx.resume();if(p&&p.catch)p.catch(()=>{})}catch(e){}
    }
    // Re-acquire Wake Lock — the browser releases it when page goes hidden
    if(_keepaliveNode) _acquireWakeLock();
    // Catch up on any reminders that were missed while backgrounded
    // (setInterval is throttled to 1min+ in hidden tabs on most browsers)
    // Re-check timer state — if a phase completed while backgrounded,
    // the tick() function may not have fired; reconcile now. Passing the
    // stall lets timer.js discard stale scheduled audio, play any chime
    // that should already have sounded, and reschedule what remains.
    // Both catch-ups wait for the fired-alarm list first (the service worker
    // may have announced the phase / reminders while the page was frozen);
    // otherwise they re-announce what was already shown.
    const catchUp=()=>{
      if(typeof checkReminders==='function'){
        try{checkReminders()}catch(e){}
      }
      if(typeof _reconcileTimerAfterWake==='function'){
        try{_reconcileTimerAfterWake({audioStalledSec:stalledSec})}catch(e){}
      }
    };
    if(typeof window!=='undefined'&&window.OdtaAlarms&&typeof window.OdtaAlarms.refreshFired==='function'){
      let p=null;try{p=window.OdtaAlarms.refreshFired()}catch(e){}
      if(p&&typeof p.then==='function')p.then(catchUp,catchUp);else catchUp();
    }else catchUp();
    _audioClockRef=null;
  }
});

// ========== WORKER-BASED BACKGROUND TICK ==========
// setInterval is throttled to 1+ second intervals in hidden tabs, and can be
// frozen entirely on mobile. A Web Worker's timer is NOT throttled. We spin
// up a tiny inline Worker that ticks every 1s and postMessage's back to the
// main thread, which fires the tick/reminder functions.
let _bgWorker=null;
function _startBgWorker(){
  if(_bgWorker) return;
  try{
    const blob=new Blob([
      'let id=null;onmessage=function(e){' +
      'if(e.data==="start"){if(id)clearInterval(id);id=setInterval(function(){postMessage("tick")},1000)}' +
      'if(e.data==="stop"){if(id){clearInterval(id);id=null}}}'
    ],{type:'application/javascript'});
    const url=URL.createObjectURL(blob);
    try{
      _bgWorker=new Worker(url);
      _bgWorker.onmessage=function(){
        // This fires every 1s even when the tab is backgrounded
        _bgWorkerTick();
      };
      _bgWorker.postMessage('start');
    }finally{
      // Browser keeps the worker source alive; the URL itself is no longer needed.
      URL.revokeObjectURL(url);
    }
  }catch(e){
    // Workers may be blocked by CSP or not available — fall back silently
    _bgWorker=null;
  }
}
function _stopBgWorker(){
  if(!_bgWorker)return;
  try{_bgWorker.postMessage('stop');_bgWorker.terminate()}catch(e){}
  _bgWorker=null;
}

/**
 * Called every ~1s by the background Worker. Drives timer tick and reminder
 * checks even when setInterval is throttled.
 */
function _bgWorkerTick(){
  // Drive the Pomodoro tick if running
  if(typeof tick==='function'&&typeof running!=='undefined'&&running){
    try{tick()}catch(e){}
  }
  // Drive quick-timer ticks
  if(typeof quickTimers!=='undefined'&&Array.isArray(quickTimers)&&quickTimers.some(qt=>qt.running)){
    // The quickTick global handler in timer.js covers this, but it uses
    // setInterval which is throttled. We fire it from here as a backstop.
    if(typeof _bgQuickTick==='function'){
      try{_bgQuickTick()}catch(e){}
    }
  }
  // Drive stopwatch tick
  if(typeof swRunning!=='undefined'&&swRunning&&typeof swTick==='function'){
    try{swTick()}catch(e){}
  }
  // Drive reminder checks (every ~30s via a counter to avoid flooding)
  if(!_bgWorkerTick._reminderCounter) _bgWorkerTick._reminderCounter=0;
  _bgWorkerTick._reminderCounter++;
  if(_bgWorkerTick._reminderCounter>=30){
    _bgWorkerTick._reminderCounter=0;
    if(typeof checkReminders==='function'){
      try{checkReminders()}catch(e){}
    }
  }
}

/**
 * Start/stop the background worker in sync with any timer running.
 * Called from startKeepalive/stopKeepalive so the worker only lives
 * when something actually needs reliable background ticking.
 */
// Patch startKeepalive/stopKeepalive to also manage the worker
const _origStartKeepalive=startKeepalive;
const _origStopKeepalive=stopKeepalive;
startKeepalive=function(){_origStartKeepalive();_startBgWorker()};
stopKeepalive=function(){_origStopKeepalive();_stopBgWorker()};

