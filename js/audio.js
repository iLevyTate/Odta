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
(function(){
  if(typeof document === 'undefined') return;
  let primed = false;
  const prime = () => {
    if(primed) return;
    try{
      const x = getAudioCtx();
      if(x && x.state === 'suspended' && typeof x.resume === 'function'){
        x.resume().catch(()=>{});
      }
      primed = true;
      document.removeEventListener('pointerdown', prime, true);
      document.removeEventListener('keydown',     prime, true);
      document.removeEventListener('touchstart',  prime, true);
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
function startKeepalive(){
  if(_keepaliveNode)return;
  try{
    const x=getAudioCtx();
    _keepaliveNode=x.createOscillator();
    _keepaliveGain=x.createGain();
    _keepaliveNode.type='sine';
    _keepaliveNode.frequency.value=20;
    _keepaliveGain.gain.value=0.0001;
    _keepaliveNode.connect(_keepaliveGain);
    _keepaliveGain.connect(x.destination);
    _keepaliveNode.start();
  }catch(e){}
  _acquireWakeLock();
  if('mediaSession' in navigator){
    try{
      navigator.mediaSession.metadata=new MediaMetadata({
        title:'Odta Focus Timer',
        artist:'Pomodoro session in progress',
        album:'Odta'
      });
      navigator.mediaSession.playbackState='playing';
      navigator.mediaSession.setActionHandler('pause',()=>{if(running)pauseTimer()});
      navigator.mediaSession.setActionHandler('play',()=>{if(!running)startTimer()});
    }catch(e){}
  }
  updateBgAudioStatus();
}
function stopKeepalive(){
  try{if(_keepaliveNode){_keepaliveNode.stop();_keepaliveNode=null;_keepaliveGain=null}}catch(e){}
  if(_wakeLock){try{_wakeLock.release()}catch(e){}_wakeLock=null}
  if('mediaSession' in navigator){
    try{navigator.mediaSession.playbackState='none'}catch(e){}
  }
  updateBgAudioStatus();
}
function updateBgAudioStatus(){
  const el=gid('bgAudioStatus');if(!el)return;
  if(_keepaliveNode){
    el.textContent='● Active — background OK';
    el.style.color='var(--success)';
  }else{
    el.textContent='○ Idle — starts with timer';
    el.style.color='var(--text-3)';
  }
}
let _wakeLock=null;

/**
 * Acquire the Screen Wake Lock. Extracted so it can be called both from
 * startKeepalive() and from the visibilitychange handler (the browser
 * automatically releases the lock when a page becomes hidden, so we must
 * re-acquire it every time the page becomes visible again while a timer
 * is active).
 */
function _acquireWakeLock(){
  if(_wakeLock) return; // already held
  if(!('wakeLock' in navigator)) return;
  navigator.wakeLock.request('screen').then(l=>{
    _wakeLock=l;
    // When the OS releases the lock (e.g. page hidden), null it out so
    // re-acquire on visibilitychange works correctly.
    l.addEventListener('release', ()=>{ _wakeLock=null; });
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

// Bounded lookahead pre-scheduler for the (open-ended) stopwatch.
// startElapsedSec = current stopwatch elapsed seconds at scheduling time.
// Caps at min(SW_LOOKAHEAD_SEC, SW_MAX_FIRES_PER_INTERVAL) per interval.
const SW_LOOKAHEAD_SEC=3600,SW_MAX_FIRES_PER_INTERVAL=200;
function scheduleSwIntervalChimes(startElapsedSec,intervalsList,fireCounts,nodesOut){
  if(!cfg.sound)return;
  try{
    const x=getAudioCtx();
    intervalsList.forEach(iv=>{
      if(iv.intervalSec<=0)return;
      if((iv.target||'pomo')!=='sw')return;
      const c=CH[iv.chime]||CH.bell;
      const alreadyFired=(fireCounts&&fireCounts[iv.id])||0;
      let scheduled=0;
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
        scheduled++;
      }
    });
  }catch(e){}
}
function cancelSwIntervalChimes(nodesOut){
  if(!nodesOut)return;
  nodesOut.forEach(o=>{try{o.stop(0)}catch(e){}});
  nodesOut.length=0;
}

function schedulePhaseAudio(){
  cancelScheduledAudio();
  if(!cfg.sound)return;
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
  if(typeof cfg !== 'undefined' && !cfg.notif){ row.hidden = true; return; }
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
  if(!cfg.notif)return;
  if(!('Notification' in window))return;
  if(Notification.permission!=='granted')return;
  const o = opts || {};
  // ── Prefer ServiceWorker.showNotification() ──
  // This fires even when the tab is frozen / the app is backgrounded on
  // mobile, unlike main-thread `new Notification()` which requires an
  // active page context.
  if('serviceWorker' in navigator){
    navigator.serviceWorker.ready.then(reg => {
      if(reg && reg.showNotification){
        reg.showNotification(title, {
          body: body || '',
          tag: o.tag || 'odtaulai',
          renotify: true,
          icon: './icons/icon-192.png',
          badge: './icons/icon-192.png',
          silent: false,
          requireInteraction: !!o.requireInteraction,
          data: o.data || {},
        }).catch(() => {});
        return;
      }
    }).catch(() => {});
    // The SW path returns — don't also fire the main-thread fallback
    // when the SW is available to avoid double notifications.
    return;
  }
  // ── Fallback: main-thread Notification (file:// or no SW) ──
  try{
    const n=new Notification(title,{body,tag:o.tag||'odtaulai',renotify:true,silent:false});
    setTimeout(()=>{try{n.close()}catch(e){}},8000);
  }catch(e){}
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
    // Resume AudioContext (may have been suspended by OS while hidden)
    if(_audioCtx&&_audioCtx.state==='suspended'){
      try{_audioCtx.resume()}catch(e){}
    }
    // Re-acquire Wake Lock — the browser releases it when page goes hidden
    if(_keepaliveNode) _acquireWakeLock();
    // Catch up on any reminders that were missed while backgrounded
    // (setInterval is throttled to 1min+ in hidden tabs on most browsers)
    if(typeof checkReminders==='function'){
      try{checkReminders()}catch(e){}
    }
    // Re-check timer state — if a phase completed while backgrounded,
    // the tick() function may not have fired; reconcile now
    if(typeof _reconcileTimerAfterWake==='function'){
      try{_reconcileTimerAfterWake()}catch(e){}
    }
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

