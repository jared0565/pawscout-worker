// Glance browser JS (Phase 3) - a STRING of browser JS composed into the single
// inline <script> by page.ts (after the shared helpers el/setMsg/esc/api/errText
// and the inbox JS, whose hoisted ibxRelAge it reuses; before the init calls and
// routerJs).
//
// Escaping conventions (same as page.ts / inbox-js.ts): browser JS inside a TS
// template literal - backticks and dollar-brace must not appear unescaped, and
// any backslash intended for the browser must be double-escaped. All markup is
// built with '+' concatenation and every dynamic value goes through esc().
//
// Honesty rule: this renderer only formats what /api/glance returned; a missing
// fact renders as an explicit "none"/"no record" state, never a made-up value.
export const glanceJs = `
// --- Glance (Phase 3): landing dashboard ---
function glParseTs(iso){
  if(!iso) return NaN;
  var s=String(iso);
  if(s.indexOf('T')<0) s=s.replace(' ','T');
  if(s.indexOf('Z')<0&&s.indexOf('+')<0) s+='Z'; // D1 timestamps are UTC without a zone
  return Date.parse(s);
}
function glTime(iso){
  var t=glParseTs(iso);
  if(isNaN(t)) return '';
  var d=new Date(t);
  if(Date.now()-t<86400000) return d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
  return d.toLocaleDateString([], {day:'numeric',month:'short'})+' '+d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
}
function glAgeHours(iso){
  var t=glParseTs(iso);
  if(isNaN(t)) return null;
  return (Date.now()-t)/3600000;
}
function glKpi(label,num,sub,flag){
  return '<div class="gl-kpi'+(flag?' '+flag:'')+'">'
    +'<div class="lbl">'+esc(label)+'</div>'
    +'<div class="num">'+esc(String(num))+'</div>'
    +'<div class="sub">'+esc(sub||'')+'</div>'
    +'</div>';
}
var GL_ORDER_STATUS={received:'received',queued:'queued',submitted:'sent to CJ','awaiting-payment':'awaiting CJ payment',fulfilled:'fulfilled',cancelled:'cancelled',error:'error'};
// Rail badge (Phase 4): the Inbox nav item carries the Open (unprocessed) queue
// size from /api/glance - the SAME query the Inbox default list runs, so the
// badge always equals what opening the Inbox shows (a thread counts whether or
// not its draft is generated yet). Hidden entirely at zero.
function updateRailBadge(n){
  var b=el('rail-inbox-badge'); if(!b) return;
  n=Number(n)||0;
  b.hidden=n<=0;
  b.textContent=n>99?'99+':String(n);
}
function glInboxSub(k){
  if(!k.openThreads) return 'nothing waiting';
  if(!k.pendingDrafts) return 'drafts being prepared';
  var s=k.pendingDrafts+' draft'+(k.pendingDrafts===1?'':'s')+' ready';
  if(k.oldestPendingAt) s+=' · oldest '+ibxRelAge(k.oldestPendingAt);
  return s;
}
function renderGlanceKpis(k){
  updateRailBadge(k.openThreads);
  var box=el('gl-kpis'); if(!box) return;
  var pipeParts=[];
  for(var st in k.pipeline){ pipeParts.push(k.pipeline[st]+' '+(GL_ORDER_STATUS[st]||st)); }
  box.innerHTML=''
    +glKpi('Inbox to process',k.openThreads,glInboxSub(k),k.openThreads?'warn':'')
    +glKpi('Auto-sent, 24 h',k.autoSent24h,k.autoSent24h?'sent without review':'no automatic sends',k.autoSent24h?'ok':'')
    +glKpi('Orders held',k.ordersHeld,k.ordersHeld?'need your decision':'none held',k.ordersHeld?'crit':'')
    +glKpi('Orders in pipeline',k.ordersInPipeline,pipeParts.length?pipeParts.join(' · '):'none active','')
    +glKpi('Live products',k.liveProducts,'imported and live','')
    +glKpi('Low stock',k.lowStock,'re-checked every 15 min',k.lowStock?'warn':'');
}
function renderGlanceAttention(rows){
  var box=el('gl-attn'); if(!box) return;
  if(!rows.length){ box.innerHTML='<p class="gl-empty">All clear - nothing needs a decision right now.</p>'; return; }
  var LABELS={inbox:'Go to Inbox',ops:'Open Operations',catalog:'Open Catalog',settings:'Open Settings'};
  box.innerHTML='';
  for(var i=0;i<rows.length;i++){
    var a=rows[i];
    var row=document.createElement('div');
    row.className='gl-attn-row '+(a.level==='crit'?'crit':a.level==='info'?'info':'warn');
    row.innerHTML='<div class="what"><span class="t">'+esc(a.title)+'</span><span class="d">'+esc(a.detail||'')+'</span></div>';
    var btn=document.createElement('button');
    btn.type='button'; btn.className='ghost';
    btn.textContent=LABELS[a.route]||'Open';
    (function(route){ btn.onclick=function(){ location.hash='#/'+route; }; })(a.route);
    row.appendChild(btn);
    box.appendChild(row);
  }
}
function renderGlanceActivity(rows){
  var box=el('gl-activity'); if(!box) return;
  if(!rows.length){ box.innerHTML='<p class="gl-empty">No recent activity recorded.</p>'; return; }
  var html='';
  for(var i=0;i<rows.length;i++){
    var a=rows[i]; var text='';
    if(a.kind==='auto_reply') text='Auto-sent reply to <span class="who">'+esc(a.who)+'</span> <span class="ibx-tag cat">auto</span>';
    else if(a.kind==='reply') text='You approved a reply to <span class="who">'+esc(a.who)+'</span>';
    else if(a.kind==='inbound') text='Email received from <span class="who">'+esc(a.who)+'</span>';
    else text='Order <span class="who">'+esc(a.who)+'</span> '+esc(GL_ORDER_STATUS[a.detail]||a.detail||'');
    html+='<div class="gl-feed-row"><time>'+esc(glTime(a.at))+'</time><div>'+text+'</div></div>';
  }
  box.innerHTML=html;
}
function glHealthChip(iso,freshHours,ranLabel){
  if(!iso) return '<span class="muted">no record yet</span>';
  var age=glAgeHours(iso);
  if(age!=null&&age<=freshHours) return '<span class="badge ok">'+esc(ranLabel+' '+glTime(iso))+'</span>';
  return '<span class="badge no">last '+esc(ibxRelAge(iso))+' ago</span>';
}
function renderGlanceHealth(h){
  var box=el('gl-health'); if(!box) return;
  function kv(k,v){ return '<div class="gl-kv"><span class="k">'+esc(k)+'</span><span>'+v+'</span></div>'; }
  var mail;
  if(!h.lastInboundAt&&!h.lastOutboundAt) mail='<span class="muted">no mail recorded</span>';
  else mail='<span class="muted">in '+(h.lastInboundAt?esc(ibxRelAge(h.lastInboundAt))+' ago':'none')+' · out '+(h.lastOutboundAt?esc(ibxRelAge(h.lastOutboundAt))+' ago':'none')+'</span>';
  box.innerHTML=''
    +kv('Nightly maintenance',glHealthChip(h.dailyLastRunAt,36,'ran'))
    +kv('Order pipeline (15 min)',glHealthChip(h.pipelineLastRunAt,1,'ran'))
    +kv('Supplier API (CJ)',h.cjConnected?'<span class="badge ok">connected</span>':'<span class="badge no">not connected</span>')
    +kv('Email in / out',mail);
}
function renderGlanceMarkets(m){
  var box=el('gl-markets'); if(!box) return;
  if(!m||!m.markets||!m.markets.length){
    box.innerHTML='<p class="gl-empty">Populates after the next nightly reconcile (04:17).</p>';
    return;
  }
  var cells='';
  for(var i=0;i<m.markets.length;i++){
    var mk=m.markets[i];
    cells+='<div class="gl-market-cell"><div class="num">'+esc(String(mk.excluded))+'</div><div class="sub">excluded from '+esc(mk.name)+'</div></div>';
  }
  box.innerHTML='<div class="gl-market-grid">'+cells+'</div>'
    +(m.at?'<p class="gl-empty" style="padding:8px 16px">Last reconciled '+esc(ibxRelAge(m.at))+' ago.</p>':'');
}
async function loadGlance(){
  var d=el('gl-date');
  if(d) d.textContent=new Date().toLocaleDateString([], {weekday:'long',day:'numeric',month:'long',year:'numeric'})+', '+new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
  setMsg('gl-msg','','muted');
  try{
    var r=await api('/glance',{});
    if(!r.ok){ setMsg('gl-msg','Could not load the overview: '+(r.error||'unknown error'),'no'); return; }
    renderGlanceKpis(r.kpis||{});
    renderGlanceAttention(r.attention||[]);
    renderGlanceActivity(r.activity||[]);
    renderGlanceHealth(r.health||{});
    renderGlanceMarkets(r.markets||null);
  }catch(e){ setMsg('gl-msg','Could not load the overview: '+errText(e),'no'); }
}
`;
