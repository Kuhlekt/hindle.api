/**
 * Hindle Chat Widget v4.2
 * Deploy to: jsx-viewer/public/widget.js
 *
 * Script tag (do NOT use defer — use async or nothing):
 *   <script
 *     src="https://chatbot.hindleconsultants.com/widget.js"
 *     data-tenant="YOUR_TENANT_ID"
 *     data-color="#2563EB"
 *     data-position="bottom-right"
 *     data-label="Chat with us"
 *   ></script>
 */
(function () {
  'use strict';

  if (window.__hindleWidget) return;
  window.__hindleWidget = true;

  // ── Read script tag attributes ────────────────────────────────
  // Works with or without defer/async — scans all script[data-tenant] tags
  var sc = (function () {
    // Try currentScript first (works when not deferred)
    if (document.currentScript && document.currentScript.getAttribute('data-tenant')) {
      return document.currentScript;
    }
    // Fallback: find script tag with data-tenant attribute
    var tags = document.querySelectorAll('script[data-tenant]');
    if (tags.length) return tags[tags.length - 1];
    // Last resort: any script containing widget.js in src
    var all = document.querySelectorAll('script[src]');
    for (var i = all.length - 1; i >= 0; i--) {
      if (all[i].src && all[i].src.indexOf('widget') !== -1) return all[i];
    }
    return null;
  })();

  if (!sc) { console.warn('[HindleWidget] Could not find script tag'); return; }

  var TENANT   = sc.getAttribute('data-tenant')      || '';
  var COLOR    = sc.getAttribute('data-color')       || '#2563EB';
  var POSITION = sc.getAttribute('data-position')    || 'bottom-right';
  var LABEL    = sc.getAttribute('data-label')       || 'Chat with us';
  var HIDE_MOB = sc.getAttribute('data-hide-mobile') === 'true';
  var API_BASE = 'https://hindleapi-production.up.railway.app';

  // Debug: confirm values read from tag
  console.log('[HindleWidget] Init — tenant:', TENANT, 'color:', COLOR, 'pos:', POSITION, 'label:', LABEL);

  if (HIDE_MOB && window.innerWidth < 768) return;

  // ── Behaviour config — overridden by tenant API ───────────────
  var cfg = {
    greeting:        'Hi there! \uD83D\uDC4B How can we help you today?',
    fallback:        "I\u2019m not sure about that \u2014 let me connect you with someone.",
    tone:            'friendly',
    triggers:        ['speak to a human', 'talk to an agent', 'real person', 'urgent'],
    showHumanBtn:    true,
    humanBtnLabel:   'Speak to a Human',
    collectEmail:    true,
    systemPrompt:    '',
    kb:              [],
    preChatEnabled:  false,
    preChatFields:   [],
  };

  // ── Position ──────────────────────────────────────────────────
  var isLeft = POSITION === 'bottom-left';
  var C = COLOR;

  // ── CSS ───────────────────────────────────────────────────────
  var bubblePos = isLeft ? 'left:20px;right:auto;' : 'right:20px;left:auto;';
  var winPos    = isLeft ? 'left:14px;right:auto;' : 'right:14px;left:auto;';
  var mobWinPos = isLeft ? 'left:8px;right:auto;'  : 'right:8px;left:auto;';

  var css =
    '#_hndl *{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;margin:0;padding:0;}' +

    // Bubble
    '#_hndl_b{position:fixed;' + bubblePos + 'bottom:20px;width:56px;height:56px;border-radius:50%;background:' + C + ';' +
    'box-shadow:0 4px 22px rgba(0,0,0,.26);cursor:pointer;display:flex;align-items:center;justify-content:center;' +
    'border:none;z-index:2147483647;transition:transform .18s,box-shadow .18s;outline:none;}' +
    '#_hndl_b:hover{transform:scale(1.08);box-shadow:0 6px 28px rgba(0,0,0,.33);}' +
    '#_hndl_b svg{width:26px;height:26px;fill:#fff;}' +
    '#_hndl_u{position:absolute;top:-2px;right:-2px;min-width:18px;height:18px;border-radius:9px;background:#ef4444;' +
    'color:#fff;font-size:10px;font-weight:700;display:none;align-items:center;justify-content:center;' +
    'padding:0 4px;border:2px solid #fff;pointer-events:none;}' +

    // Chat window
    '#_hndl_w{position:fixed;' + winPos + 'bottom:88px;width:360px;max-width:calc(100vw - 28px);' +
    'height:440px;max-height:calc(100vh - 110px);background:#fff;border-radius:16px;' +
    'box-shadow:0 16px 56px rgba(0,0,0,.18);display:none;flex-direction:column;overflow:hidden;' +
    'z-index:2147483646;animation:_hup .2s ease;}' +
    '@keyframes _hup{from{opacity:0;transform:translateY(14px);}to{opacity:1;transform:translateY(0);}}' +

    // Header
    '#_hndl_h{background:' + C + ';padding:13px 15px;display:flex;align-items:center;gap:9px;flex-shrink:0;}' +
    '#_hndl_h_dot{width:8px;height:8px;border-radius:50%;background:#4ade80;flex-shrink:0;}' +
    '#_hndl_h_txt{flex:1;min-width:0;}' +
    '#_hndl_h_name{color:#fff;font-size:14px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
    '#_hndl_h_sub{color:rgba(255,255,255,.78);font-size:11px;margin-top:1px;}' +
    '#_hndl_hcl{background:rgba(255,255,255,.18);border:none;border-radius:50%;width:28px;height:28px;' +
    'cursor:pointer;display:flex;align-items:center;justify-content:center;color:#fff;' +
    'flex-shrink:0;margin-left:auto;transition:background .15s;}' +
    '#_hndl_hcl:hover{background:rgba(255,255,255,.32);}' +

    // Messages
    '#_hndl_m{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column-reverse;gap:7px;}' +
    '#_hndl_m::-webkit-scrollbar{width:3px;}' +
    '#_hndl_m::-webkit-scrollbar-thumb{background:#e2e8f0;border-radius:2px;}' +
    '._hm{display:flex;flex-direction:column;max-width:84%;}' +
    '._hm.bot{align-self:flex-start;}._hm.usr{align-self:flex-end;}' +
    '._hb{padding:9px 13px;border-radius:14px;font-size:13.5px;line-height:1.55;word-break:break-word;}' +
    '._hm.bot ._hb{background:#f1f5f9;color:#1e293b;border-bottom-left-radius:3px;}' +
    '._hm.agent ._hb{background:#dcfce7;color:#14532d;border-bottom-left-radius:3px;}' +
    '._hm.usr ._hb{background:' + C + ';color:#fff;border-bottom-right-radius:3px;}' +
    '._ht{font-size:10px;color:#94a3b8;margin-top:3px;padding:0 2px;}' +
    '._hm.usr ._ht{text-align:right;}' +

    // Typing dots
    '._htyp{display:flex;gap:4px;align-items:center;padding:10px 13px;background:#f1f5f9;border-radius:14px;border-bottom-left-radius:3px;width:50px;}' +
    '._htyp span{width:6px;height:6px;border-radius:50%;background:#94a3b8;animation:_hbnc .9s infinite;}' +
    '._htyp span:nth-child(2){animation-delay:.15s;}._htyp span:nth-child(3){animation-delay:.3s;}' +
    '@keyframes _hbnc{0%,60%,100%{transform:translateY(0);}30%{transform:translateY(-5px);}}' +

    // Email bar
    '#_hndl_eb{padding:9px 13px;border-top:1px solid #f1f5f9;background:#fafafa;' +
    'display:none;flex-direction:column;gap:6px;flex-shrink:0;}' +
    '#_hndl_eb p{font-size:11.5px;color:#64748b;}' +
    '#_hndl_er{display:flex;gap:6px;}' +
    '#_hndl_ei{flex:1;border:1px solid #e2e8f0;border-radius:8px;padding:7px 10px;font-size:12.5px;outline:none;color:#1e293b;}' +
    '#_hndl_ei:focus{border-color:' + C + ';}' +
    '#_hndl_eok{background:' + C + ';color:#fff;border:none;border-radius:8px;padding:7px 12px;cursor:pointer;font-size:12px;font-weight:600;white-space:nowrap;}' +

    // Human bar
    '#_hndl_hob{padding:10px 13px;border-top:1px solid #fde68a;display:none;' +
    'align-items:center;gap:10px;flex-shrink:0;background:#fffbeb;}' +
    '#_hndl_hobt{background:' + C + ';color:#fff;border:none;border-radius:8px;' +
    'padding:9px 16px;cursor:pointer;font-size:13px;font-weight:600;white-space:nowrap;flex-shrink:0;}' +
    '#_hndl_hobt:disabled{opacity:.55;cursor:default;}' +
    '#_hndl_hobn{font-size:11.5px;color:#92400e;line-height:1.4;flex:1;}' +

    // Input
    '#_hndl_ir{display:flex;gap:8px;padding:9px 11px;border-bottom:1px solid #f1f5f9;flex-shrink:0;background:#fff;align-items:flex-end;}' +
    '#_hndl_inp{flex:1;border:1px solid #e2e8f0;border-radius:10px;padding:9px 12px;' +
    'font-size:13.5px;outline:none;resize:none;line-height:1.4;max-height:88px;overflow-y:auto;color:#1e293b;}' +
    '#_hndl_inp:focus{border-color:' + C + ';}' +
    '#_hndl_snd{background:' + C + ';border:none;border-radius:10px;width:38px;height:38px;' +
    'cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:opacity .15s;}' +
    '#_hndl_snd:disabled{opacity:.38;cursor:default;}' +
    '#_hndl_snd svg{width:16px;height:16px;fill:#fff;}' +

    // Handoff / contact form
    '#_hndl_pcf{flex:1;overflow-y:auto;padding:20px 18px;display:flex;flex-direction:column;gap:0;}' +
    '#_hndl_pcf h3{font-size:15px;font-weight:700;color:#0f172a;margin:0 0 4px;}' +
    '#_hndl_pcf>p{font-size:12.5px;color:#64748b;margin:0 0 16px;line-height:1.5;}' +
    '._hpci{margin-bottom:12px;}' +
    '._hpci label{display:block;font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.5px;margin-bottom:5px;}' +
    '._hpci input,._hpci textarea{width:100%;padding:9px 12px;border:1.5px solid #e2e8f0;border-radius:8px;font-size:13.5px;color:#0f172a;outline:none;font-family:inherit;resize:none;box-sizing:border-box;transition:border-color .15s,box-shadow .15s;background:#fff;}' +
    '._hpci input:focus,._hpci textarea:focus{border-color:' + C + ';box-shadow:0 0 0 3px ' + C + '22;}' +
    '#_hndl_pcfsub{background:' + C + ';color:#fff;border:none;border-radius:9px;padding:12px;font-size:13.5px;font-weight:700;cursor:pointer;width:100%;margin-top:6px;letter-spacing:.2px;transition:opacity .15s;}' +
    '#_hndl_pcfsub:hover{opacity:.88;}' +
    '#_hndl_pcferr{color:#ef4444;font-size:11.5px;padding:3px 0 0;min-height:18px;}' +

    '@media(max-width:400px){#_hndl_w{width:calc(100vw - 16px);' + mobWinPos + '}}';

  var sEl = document.createElement('style');
  sEl.textContent = css;
  document.head.appendChild(sEl);

  // ── DOM ───────────────────────────────────────────────────────
  var root = document.createElement('div');
  root.id = '_hndl';
  document.body.appendChild(root);

  var bubble = document.createElement('button');
  bubble.id = '_hndl_b';
  bubble.setAttribute('aria-label', LABEL);
  bubble.innerHTML =
    '<svg id="_hndl_ico" viewBox="0 0 24 24"><path d="M20 2H4a2 2 0 00-2 2v18l4-4h14a2 2 0 002-2V4a2 2 0 00-2-2z"/></svg>' +
    '<svg id="_hndl_icox" viewBox="0 0 24 24" style="display:none"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>' +
    '<div id="_hndl_u"></div>';
  root.appendChild(bubble);

  var win = document.createElement('div');
  win.id = '_hndl_w';
  win.setAttribute('role', 'dialog');
  win.setAttribute('aria-label', LABEL);
  win.innerHTML =
    '<div id="_hndl_h">' +
      '<div id="_hndl_h_dot"></div>' +
      '<div id="_hndl_h_txt">' +
        '<div id="_hndl_h_name">' + LABEL + '</div>' +
        '<div id="_hndl_h_sub">We typically reply instantly</div>' +
      '</div>' +
      '<button id="_hndl_hcl" aria-label="Close">' +
        '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>' +
      '</button>' +
    '</div>' +
    '<div id="_hndl_pcf" style="display:none">' +
      '<h3>Connect with our team</h3>' +
      '<p>Leave your details and an agent will be with you shortly.</p>' +
      '<div id="_hndl_pcff"></div>' +
      '<p id="_hndl_pcferr"></p>' +
      '<button id="_hndl_pcfsub">Request Agent</button>' +
    '</div>' +
    '<div id="_hndl_ir">' +
      '<textarea id="_hndl_inp" placeholder="Type a message\u2026" rows="1"></textarea>' +
      '<button id="_hndl_snd" disabled aria-label="Send">' +
        '<svg viewBox="0 0 24 24"><path d="M2 21l21-9L2 3v7l15 2-15 2z"/></svg>' +
      '</button>' +
    '</div>' +
    '<div id="_hndl_m"></div>' +
    '<div id="_hndl_eb">' +
      '<p>Drop your email and we\'ll follow up if you get disconnected.</p>' +
      '<div id="_hndl_er"><input id="_hndl_ei" type="email" placeholder="your@email.com"/><button id="_hndl_eok">Save</button></div>' +
    '</div>' +
    '<div id="_hndl_hob">' +
      '<button id="_hndl_hobt">Speak to a Human</button>' +
      '<span id="_hndl_hobn">A team member will be notified</span>' +
    '</div>';
  root.appendChild(win);

  // ── Refs ──────────────────────────────────────────────────────
  function $i(id) { return document.getElementById(id); }
  var icoOpen  = $i('_hndl_ico');
  var icoClose = $i('_hndl_icox');
  var unread   = $i('_hndl_u');
  var msgs     = $i('_hndl_m');
  var emailBar = $i('_hndl_eb');
  var emailInp = $i('_hndl_ei');
  var emailOk  = $i('_hndl_eok');
  var hobBar   = $i('_hndl_hob');
  var hobBtn   = $i('_hndl_hobt');
  var hobNote  = $i('_hndl_hobn');
  var inpEl    = $i('_hndl_inp');
  var sndBtn   = $i('_hndl_snd');
  var pcfDiv   = $i('_hndl_pcf');
  var pcfFields= $i('_hndl_pcff');
  var pcfErr   = $i('_hndl_pcferr');
  var pcfSub   = $i('_hndl_pcfsub');
  var inputRow = $i('_hndl_ir');

  // ── State ─────────────────────────────────────────────────────
  var isOpen       = false;
  var loading      = false;
  var greeted      = false;
  var cfgLoaded       = false;
  var pendingGreet    = false;
  var handoffDone     = false;
  var agentPollTimer  = null;
  var lastMsgCount    = 0;
  var visitorEmail = '';
  var history      = [];
  var convId       = null;
  var sessionId    = 'hs_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  var visitorData  = {}; // collected from pre-chat form
  var formShown    = false;

  // ── Helpers ───────────────────────────────────────────────────
  function ts() { return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
  function scroll() { setTimeout(function () { msgs.scrollTop = 0; }, 40); }

  function addMsg(role, text) {
    var w = document.createElement('div'); w.className = '_hm ' + role;
    var b = document.createElement('div'); b.className = '_hb'; b.textContent = text;
    var t = document.createElement('div'); t.className = '_ht'; t.textContent = ts();
    w.appendChild(b); w.appendChild(t); msgs.appendChild(w); scroll();
  }
  function showTyping() {
    var w = document.createElement('div'); w.className = '_hm bot'; w.id = '_hndl_typing';
    var d = document.createElement('div'); d.className = '_htyp';
    d.innerHTML = '<span></span><span></span><span></span>';
    w.appendChild(d); msgs.appendChild(w); scroll();
  }
  function hideTyping() { var el = $i('_hndl_typing'); if (el) el.parentNode.removeChild(el); }

  // ── Create / reuse conversation in DB ────────────────────────
  function ensureConversation(subject) {
    if (convId) return Promise.resolve(convId);
    return fetch(API_BASE + '/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenant_id:     TENANT,
        visitor_name:  visitorEmail || 'Website Visitor',
        visitor_email: visitorEmail || '',
        page:          window.location.pathname,
        subject:       (subject || 'Chat').slice(0, 80),
        status:        'open',
      }),
    })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) { if (d && d.id) convId = d.id; return convId; })
    .catch(function () { return null; });
  }

  function saveMsg(type, sender, content) {
    if (!convId) return;
    fetch(API_BASE + '/api/conversations/' + convId + '/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: type, sender: sender, content: content }),
    }).catch(function () {});
  }

  // ── Open / Close ──────────────────────────────────────────────
  // ── Build and show pre-chat form ──────────────────────────────
  function buildForm() {
    pcfFields.innerHTML = '';
    var activeFields = cfg.preChatFields.filter(function(f){ return f.enabled; });
    activeFields.forEach(function(f) {
      var wrap = document.createElement('div'); wrap.className = '_hpci';
      var lbl = document.createElement('label');
      lbl.textContent = f.label + (f.required ? ' *' : '');
      wrap.appendChild(lbl);
      var el;
      if (f.id === 'message') {
        el = document.createElement('textarea'); el.rows = 3;
      } else {
        el = document.createElement('input');
        el.type = f.id === 'email' ? 'email' : f.id === 'phone' ? 'tel' : 'text';
      }
      el.id = '_hpci_' + f.id;
      el.placeholder = f.label;
      wrap.appendChild(el);
      pcfFields.appendChild(wrap);
    });
  }

  function showForm(forHandoff) {
    formShown = true;
    // Update heading and button based on context
    var h3 = pcfDiv.querySelector('h3');
    var p  = pcfDiv.querySelector('p:first-of-type');
    if (h3) h3.textContent = forHandoff ? 'Connect with our team' : 'Before we start';
    if (p)  p.textContent  = forHandoff ? 'Leave your details and an agent will be with you shortly.' : 'Please fill in your details so we can help you better.';
    pcfSub.textContent = forHandoff ? 'Request Agent' : 'Start Chat';
    pcfSub._forHandoff = forHandoff || false;
    formShown = true;
    pcfDiv.style.display = 'flex';
    pcfDiv.style.flexDirection = 'column';
    msgs.style.display = 'none';
    emailBar.style.display = 'none';
    hobBar.style.display = 'none';
    inputRow.style.display = 'none';
    buildForm();
    var first = pcfFields.querySelector('input,textarea');
    if (first) setTimeout(function(){ first.focus(); }, 100);
  }

  function submitForm() {
    pcfErr.textContent = '';
    var activeFields = cfg.preChatFields.filter(function(f){ return f.enabled; });
    var valid = true;
    activeFields.forEach(function(f) {
      var el = document.getElementById('_hpci_' + f.id);
      if (!el) return;
      var val = el.value.trim();
      if (f.required && !val) {
        pcfErr.textContent = f.label + ' is required.';
        el.style.borderColor = '#ef4444';
        valid = false;
      } else {
        el.style.borderColor = '';
        if (val) visitorData[f.id] = val;
      }
    });
    if (!valid) return;
    // Store collected data
    if (visitorData.email) visitorEmail = visitorData.email;
    // Hide form, show chat
    pcfDiv.style.display = 'none';
    msgs.style.display = 'flex';
    inputRow.style.display = 'flex';
    formShown = false;
    if (pcfSub._forHandoff) {
      hobBar.style.display = 'flex';
      fireHandoff();
    } else {
      doGreet();
    }
  }

  pcfSub.addEventListener('click', submitForm);
  pcfFields.addEventListener('keydown', function(e){
    if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') { e.preventDefault(); submitForm(); }
  });

  function doGreet() {
    if (greeted) return;
    greeted = true;
    setTimeout(function () {
      // Personalise greeting if name collected
      var g = cfg.greeting;
      if (visitorData.name) g = g.replace('there', visitorData.name).replace('Hi!', 'Hi ' + visitorData.name + '!');
      addMsg('bot', g);
      if (cfg.collectEmail !== false && !visitorEmail) setTimeout(function () { emailBar.style.display = 'flex'; }, 700);
      if (cfg.showHumanBtn !== false) {
        hobBtn.textContent = cfg.humanBtnLabel || 'Speak to a Human';
        hobBar.style.display = 'flex';
      }
      // Tell the server about the visitor's form data
      if (Object.keys(visitorData).length > 0) {
        ensureConversation('New Chat').then(function() {
          if (convId) {
            fetch(API_BASE + '/api/conversations/' + convId, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                visitor_name: visitorData.name || visitorData.email || 'Website Visitor',
                visitor_email: visitorData.email || null,
              }),
            }).catch(function(){});
            // Save form data as first message for agent context
            var summary = Object.entries(visitorData).map(function(kv){ return kv[0] + ': ' + kv[1]; }).join(', ');
            saveMsg('system', 'System', 'Visitor details: ' + summary);
          }
        });
      }
    }, 300);
  }

  function open() {
    isOpen = true;
    win.style.display = 'flex';
    icoOpen.style.display  = 'none';
    icoClose.style.display = 'block';
    unread.style.display   = 'none';

    if (!greeted) {
      if (cfgLoaded) {
        doGreet();
      } else {
        pendingGreet = true;
      }
    } else {
      inpEl.focus();
    }
  }
  function close() {
    isOpen = false;
    win.style.display  = 'none';
    icoOpen.style.display  = 'block';
    icoClose.style.display = 'none';
  }

  bubble.addEventListener('click', function () { isOpen ? close() : open(); });
  $i('_hndl_hcl').addEventListener('click', close);

  // ── Email capture ─────────────────────────────────────────────
  emailOk.addEventListener('click', function () {
    var v = emailInp.value.trim();
    if (!v || v.indexOf('@') < 1) return;
    visitorEmail = v;
    emailBar.style.display = 'none';
    addMsg('bot', 'Thanks \u2014 got your email.');
    if (convId) {
      fetch(API_BASE + '/api/conversations/' + convId, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visitor_email: v, visitor_name: v }),
      }).catch(function () {});
    }
  });
  emailInp.addEventListener('keydown', function (e) { if (e.key === 'Enter') emailOk.click(); });

  // ── Input ─────────────────────────────────────────────────────
  inpEl.addEventListener('input', function () {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 88) + 'px';
    sndBtn.disabled = !this.value.trim() || loading;
  });
  inpEl.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  sndBtn.addEventListener('click', send);

  function checkTriggers(text) {
    if (handoffDone || cfg.showHumanBtn === false) return;
    var lo = text.toLowerCase();
    if (cfg.triggers.some(function (t) { return lo.indexOf(t.toLowerCase()) !== -1; })) {
      hobBar.style.display = 'flex';
    }
  }

  // ── Send ──────────────────────────────────────────────────────
  function send() {
    var text = inpEl.value.trim();
    if (!text || loading) return;
    inpEl.value = ''; inpEl.style.height = 'auto';
    sndBtn.disabled = true; loading = true;
    addMsg('usr', text);
    history.push({ role: 'user', content: text });
    checkTriggers(text);
    showTyping();

    ensureConversation(text).then(function () {
      saveMsg('visitor', visitorEmail || 'Visitor', text);
      var kbCtx = cfg.kb && cfg.kb.length
        ? '\n\nKnowledge base:\n' + cfg.kb.map(function (k) { return (k.title ? k.title + ':\n' : '') + (k.content || k.text || ''); }).join('\n---\n')
        : '';
      var sys = cfg.systemPrompt
        ? cfg.systemPrompt + (kbCtx ? '\n\nAnswer from knowledge base:\n' + kbCtx : '')
        : 'You are a helpful AI support assistant. Tone: ' + cfg.tone + '. Be concise. If unsure say: "' + cfg.fallback + '".' + kbCtx;

      return fetch(API_BASE + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenantId: TENANT, sessionId: sessionId, conversationId: convId, visitorEmail: visitorEmail, messages: history.slice(-14), system: sys }),
      });
    })
    .then(function (r) { return r && r.ok ? r.json() : Promise.reject('err'); })
    .then(function (d) {
      hideTyping();
      var reply = d.reply || d.content || cfg.fallback;
      addMsg('bot', reply);
      history.push({ role: 'assistant', content: reply });
      saveMsg('bot', 'AI', reply);
      checkTriggers(reply);
      loading = false; sndBtn.disabled = !inpEl.value.trim();
    })
    .catch(function () {
      hideTyping();
      addMsg('bot', cfg.fallback);
      loading = false; sndBtn.disabled = !inpEl.value.trim();
    });
  }

  // ── Handoff ───────────────────────────────────────────────────
  function fireHandoff() {
    hobBtn.disabled = true;
    hobNote.textContent = 'Alerting your team\u2026';

    ensureConversation('Handoff requested').then(function () {
      return fetch(API_BASE + '/api/handoff', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenantId:       TENANT,
          sessionId:      sessionId,
          conversationId: convId,
          visitorEmail:   visitorEmail,
          visitorName:    visitorData.name || visitorEmail || 'Website Visitor',
          visitorPhone:   visitorData.phone || null,
          visitorCompany: visitorData.company || null,
          page:           window.location.pathname,
          url:            window.location.href,
          history:        history.slice(-10),
        }),
      });
    })
    .then(function (r) { return r && r.ok ? r.json() : Promise.reject('HTTP ' + (r ? r.status : 'err')); })
    .then(function (d) {
      handoffDone = true;
      hobBtn.textContent = '\u2713 Agent notified';
      hobBtn.style.background = '#16a34a';
      hobNote.textContent = d.smsSent
        ? 'A team member has been alerted by SMS and will join shortly.'
        : 'Request logged \u2014 a team member will be with you shortly.';
      addMsg('bot', 'You\u2019re all set \u2014 a team member will join your chat shortly.');
      // Start polling for agent replies every 4s
      if (convId && !agentPollTimer) {
        agentPollTimer = setInterval(function () {
          fetch(API_BASE + '/api/conversations/' + convId + '/messages')
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (msgs) {
              if (!msgs) return;
              // Only show new agent messages (not bot/system messages already shown)
              var agentMsgs = msgs.filter(function (m) { return m.type === 'agent'; });
              if (agentMsgs.length > lastMsgCount) {
                var newOnes = agentMsgs.slice(lastMsgCount);
                newOnes.forEach(function (m) {
                  addMsg('agent', (m.sender && m.sender !== 'You' ? m.sender + ': ' : '') + m.content);
                });
                lastMsgCount = agentMsgs.length;
              }
            })
            .catch(function () {});
        }, 4000);
      }
    })
    .catch(function (err) {
      console.warn('[HindleWidget] Handoff error:', err);
      handoffDone = true;
      hobBtn.textContent = '\u2713 Request sent';
      hobBtn.style.background = '#16a34a';
      hobNote.textContent = 'Your request has been logged \u2014 a team member will be in touch.';
      addMsg('bot', 'Your request has been logged \u2014 a team member will be in touch shortly.');
      // Still poll for agent replies even if handoff endpoint errored
      if (convId && !agentPollTimer) {
        agentPollTimer = setInterval(function () {
          fetch(API_BASE + '/api/conversations/' + convId + '/messages')
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (msgs) {
              if (!msgs) return;
              var agentMsgs = msgs.filter(function (m) { return m.type === 'agent'; });
              if (agentMsgs.length > lastMsgCount) {
                agentMsgs.slice(lastMsgCount).forEach(function (m) {
                  addMsg('agent', (m.sender && m.sender !== 'You' ? m.sender + ': ' : '') + m.content);
                });
                lastMsgCount = agentMsgs.length;
              }
            }).catch(function () {});
        }, 4000);
      }
    });
  }

  hobBtn.addEventListener('click', function () {
    if (handoffDone) return;
    var hasFields = cfg.preChatEnabled && cfg.preChatFields && cfg.preChatFields.some(function(f){ return f.enabled; });
    if (hasFields && !formShown) {
      showForm(true);
    } else {
      fireHandoff();
    }
  });

  // ── Load tenant config (AI behaviour only — appearance from script tag) ──
  if (TENANT) {
    fetch(API_BASE + '/api/tenant-config/' + TENANT)
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        // Always mark config as loaded — even if fetch returned 404/null
        cfgLoaded = true;
        if (!d) {
          // No config in DB yet — greet with defaults
          if (pendingGreet && !greeted) {
            pendingGreet = false;
            doGreet(); // No config in DB yet — greet with defaults
          }
          return;
        }
        if (d.greeting)                    cfg.greeting        = d.greeting;
        if (d.fallback)                    cfg.fallback        = d.fallback;
        if (d.tone)                        cfg.tone            = d.tone;
        if (d.triggers)                    cfg.triggers        = d.triggers;
        if (d.kb)                          cfg.kb              = d.kb;
        if (d.humanBtnLabel)               cfg.humanBtnLabel   = d.humanBtnLabel;
        if (d.showHumanBtn !== undefined)  cfg.showHumanBtn    = d.showHumanBtn;
        if (d.collectEmail  !== undefined) cfg.collectEmail    = d.collectEmail;
        if (d.systemPrompt)                cfg.systemPrompt    = d.systemPrompt;
        if (d.preChatEnabled !== undefined) cfg.preChatEnabled = d.preChatEnabled;
        if (d.preChatFields && d.preChatFields.length) cfg.preChatFields = d.preChatFields;
        if (greeted && hobBar.style.display === 'flex') hobBtn.textContent = cfg.humanBtnLabel || 'Speak to a Human';
        if (cfg.showHumanBtn === false) hobBar.style.display = 'none';
        // If widget was opened before config loaded, greet now with correct settings
        cfgLoaded = true;
        if (pendingGreet && !greeted) {
          pendingGreet = false;
          doGreet();
        }
      })
      .catch(function () {
        // Config fetch failed — greet with defaults if waiting
        cfgLoaded = true;
        if (pendingGreet && !greeted) {
          pendingGreet = false;
          doGreet(); // Config failed to load — greet with defaults, no pre-chat form
        }
      });
  } else {
    // No tenant — mark config as loaded so greet works immediately
    cfgLoaded = true;
  }

  // ── Unread badge after 5s ─────────────────────────────────────
  setTimeout(function () {
    if (!isOpen) { unread.textContent = '1'; unread.style.display = 'flex'; }
  }, 5000);

}());
