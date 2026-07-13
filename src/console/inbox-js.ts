// Inbox workspace browser JS (Phase 2) - a STRING of browser JS composed into
// the single inline <script> by page.ts (after the shared helpers el/setMsg/esc/
// api/errText, which it uses freely via function hoisting; before the init calls
// and routerJs).
//
// Escaping conventions (same as page.ts): this is browser JS inside a TS template
// literal, so backticks and dollar-brace must not appear unescaped, and any
// backslash intended for the BROWSER must be double-escaped here. All markup is
// built with '+' string concatenation and every dynamic value goes through esc().
//
// Replaces the Phase-1 thread modal (openInboxModal/closeInboxModal/
// wireInboxModal are gone): clicking a row loads the conversation into the
// center pane and the context rail in place. window.confirm() is unreliable in
// the Shopify admin iframe, so the unsent-draft-edits guard is an inline
// two-click confirm (same pattern as the fulfilment-mode arm/confirm).
export const inboxJs = `
// --- Inbox workspace (Phase 2): three-pane mail UI ---
var ibxSelectedId=null;      // thread id currently open in the center pane
var inboxDraftOriginal='';   // draft body as rendered - baseline for the unsent-edits guard
var ibxSwitchArmedId=null;   // two-click confirm target when leaving unsent edits
var ibxSwitchTimer=null;
var inboxInvoiceItems=[];    // invoice builder items [{variantId,title,qty,priceGbp}]
var IBX_STATUS_LABELS={new:'New',needs_reply:'Needs reply',awaiting_customer:'Awaiting customer',converted:'Converted',closed:'Closed',spam:'Spam'};
var IBX_STATUS_KIND={new:'no',needs_reply:'no',awaiting_customer:'',converted:'ok',closed:'',spam:''};
function ibxAgentName(key){
  // INBOX_AGENTS is the settings-panel [key,displayName] list defined in page.ts
  // (same script block); used here to translate a thread category into the
  // department that drafted the reply.
  if(typeof INBOX_AGENTS!=='undefined'){
    for(var i=0;i<INBOX_AGENTS.length;i++){ if(INBOX_AGENTS[i][0]===key) return INBOX_AGENTS[i][1]; }
  }
  return key||'';
}
function ibxRelAge(iso){
  if(!iso) return '';
  var s=String(iso);
  if(s.indexOf('T')<0) s=s.replace(' ','T');
  if(s.indexOf('Z')<0&&s.indexOf('+')<0) s+='Z'; // D1 timestamps are UTC without a zone
  var t=Date.parse(s);
  if(isNaN(t)) return '';
  var sec=Math.max(0,(Date.now()-t)/1000);
  if(sec<60) return 'now';
  if(sec<3600) return Math.floor(sec/60)+'m';
  if(sec<86400) return Math.floor(sec/3600)+'h';
  return Math.floor(sec/86400)+'d';
}
function ibxHoldReasons(draft){
  if(!draft||!draft.hold_reasons) return [];
  try{ var a=JSON.parse(draft.hold_reasons); return Array.isArray(a)?a:[]; }catch(e){ return []; }
}
function ibxDayLabel(iso){
  var s=String(iso||'');
  if(s.indexOf('T')<0) s=s.replace(' ','T');
  if(s.indexOf('Z')<0&&s.indexOf('+')<0) s+='Z'; // D1 timestamps are UTC without a zone
  var t=Date.parse(s);
  if(isNaN(t)) return String(iso||'').slice(0,10);
  return new Date(t).toLocaleDateString([], {weekday:'short',day:'numeric',month:'short'});
}
// Read-only automation pills in the Inbox header AND the Glance header, derived
// from /inbox/config (already loaded by loadInboxSettings, which calls this).
function renderInboxAutoPill(cfg){
  var text, cls;
  if(!cfg||!cfg.autosend){ text='Manual review'; cls='ibx-pill'; }
  else{
    var agents=cfg.agents||{}; var names=[];
    for(var k in agents){ if(agents[k]&&agents[k].autosend) names.push(ibxAgentName(k)); }
    text=names.length?('Auto: '+names.join(', ')):'Auto (no agents enabled)';
    cls='ibx-pill is-auto';
  }
  var ids=['ibx-auto-pill','gl-auto-pill'];
  for(var i=0;i<ids.length;i++){ var p=el(ids[i]); if(p){ p.textContent=text; p.className=cls; } }
}
// --- Filter chips <-> status select (single source of truth: the select) ---
function ibxSyncFilterChips(){
  var v=(el('inbox-status-filter')&&el('inbox-status-filter').value)||'';
  var chips=document.querySelectorAll('#ibx-filter-chips .ibx-chip');
  for(var i=0;i<chips.length;i++){
    if(chips[i].getAttribute('data-filter')===v) chips[i].classList.add('is-on');
    else chips[i].classList.remove('is-on');
  }
}
function ibxSetFilter(v){ var s=el('inbox-status-filter'); if(s) s.value=v; ibxSyncFilterChips(); loadInboxThreads(); }
function ibxFilterFromSelect(){ ibxSyncFilterChips(); loadInboxThreads(); }
// --- Thread list (left pane) ---
async function loadInboxThreads(){
  var status=(el('inbox-status-filter')&&el('inbox-status-filter').value)||'';
  var list=el('inbox-threads');
  if(list) list.innerHTML='<p class="muted" style="padding:12px">Loading…</p>';
  setMsg('inboxmsg','','muted');
  try{
    var body=status?{status:status}:{};
    var r=await api('/inbox/threads',body);
    if(!r.ok){ if(list) list.innerHTML='<p class="msg no" style="padding:12px">'+esc(r.error||'Failed to load threads')+'</p>'; return; }
    // Every list load carries the fresh Open-queue size: keep the rail badge in
    // lockstep (updateRailBadge is hoisted from the glance block of this script).
    if(typeof r.openCount==='number') updateRailBadge(r.openCount);
    renderInboxThreads(r.threads||[]);
  }catch(e){ if(list) list.innerHTML='<p class="msg no" style="padding:12px">'+esc(errText(e))+'</p>'; }
}
function renderInboxThreads(threads){
  var list=el('inbox-threads');
  if(!list) return;
  if(!threads.length){ list.innerHTML='<div class="ibx-empty"><p>Inbox zero</p><p class="muted">No conversations match this filter.</p></div>'; return; }
  list.innerHTML='';
  for(var i=0;i<threads.length;i++){
    var t=threads[i];
    var row=document.createElement('button');
    row.type='button';
    row.className='ibx-row'+(t.id===ibxSelectedId?' is-sel':'');
    row.setAttribute('data-id',t.id);
    var st=IBX_STATUS_LABELS[t.status]||t.status||'';
    var chips='';
    if(t.category) chips+='<span class="ibx-tag cat">'+esc(t.category)+'</span>';
    // Phase 3: the list API now carries hasDraft (a real pending-draft flag).
    if(t.hasDraft) chips+='<span class="ibx-tag draft">draft ready</span>';
    if(st) chips+='<span class="ibx-tag '+(IBX_STATUS_KIND[t.status]||'')+'">'+esc(st)+'</span>';
    // Phase 3: show the person (contactName from inbox_contacts) over the bare address.
    row.innerHTML='<span class="ibx-row__top"><span class="ibx-row__who">'+esc(t.contactName||t.contactEmail||'(unknown)')+'</span><span class="ibx-row__age">'+esc(ibxRelAge(t.lastMessageAt))+'</span></span>'
      +'<span class="ibx-row__subj">'+esc(t.subject||'(no subject)')+'</span>'
      +(chips?'<span class="ibx-row__chips">'+chips+'</span>':'');
    (function(id){ row.onclick=function(){ ibxRowClick(id); }; })(t.id);
    list.appendChild(row);
  }
}
function ibxDraftEdited(){
  var d=el('inbox-draft');
  if(!d) return false;
  return d.innerText.trim()!==inboxDraftOriginal.trim();
}
function ibxRowClick(id){
  // Unsent-edits guard: confirm() is unreliable inside the admin iframe, so use
  // an inline two-click confirm (click the same row again within 8s to discard).
  if(id!==ibxSelectedId&&ibxDraftEdited()&&ibxSwitchArmedId!==id){
    ibxSwitchArmedId=id;
    if(ibxSwitchTimer) clearTimeout(ibxSwitchTimer);
    ibxSwitchTimer=setTimeout(function(){ ibxSwitchArmedId=null; },8000);
    setMsg('ibx-msg','You have unsent draft edits - click that thread again to discard them.','no');
    return;
  }
  ibxSwitchArmedId=null;
  openInboxThread(id);
}
// --- Conversation (center pane) + context rail (right pane) ---
async function openInboxThread(id){
  ibxSelectedId=id;
  var rows=document.querySelectorAll('#inbox-threads .ibx-row');
  for(var i=0;i<rows.length;i++){
    if(rows[i].getAttribute('data-id')===id) rows[i].classList.add('is-sel');
    else rows[i].classList.remove('is-sel');
  }
  var tl=el('ibx-timeline');
  if(tl) tl.innerHTML='<div class="ibx-empty"><p class="muted">Loading thread…</p></div>';
  setMsg('ibx-msg','','muted');
  try{
    var r=await api('/inbox/thread',{id:id});
    if(!r.ok){ if(tl) tl.innerHTML='<div class="ibx-empty"><p class="msg no">'+esc(r.error||'Failed to load thread')+'</p></div>'; return; }
    renderInboxThread(r.thread,r.messages||[],r.labels||[],r.draft||null,r.invoice||null,r.applicant||null,r.contact||null,r.partnerPool||'none',(r.partnerConsent===true||r.partnerConsent===false)?r.partnerConsent:null,r.events||[]);
  }catch(e){ if(tl) tl.innerHTML='<div class="ibx-empty"><p class="msg no">'+esc(errText(e))+'</p></div>'; }
}
function renderInboxThread(thread,messages,labels,draft,invoice,applicant,contact,partnerPool,partnerConsent,events){
  var head=el('ibx-convo-head'), tl=el('ibx-timeline');
  if(!head||!tl) return;
  inboxInvoiceItems=[];
  inboxDraftOriginal=(draft&&draft.body_text)||''; // baseline for the unsent-edits guard
  var tid=thread.id;
  // Header: subject + contact email + category chip + status select (auto-saves on change)
  var statOpts=['new','needs_reply','awaiting_customer','converted','closed','spam'];
  var statSel='<select id="inbox-status-sel" class="ibx-status-sel" aria-label="Thread status">';
  for(var k=0;k<statOpts.length;k++){
    statSel+='<option value="'+esc(statOpts[k])+'"'+(thread.status===statOpts[k]?' selected':'')+'>'+esc(IBX_STATUS_LABELS[statOpts[k]]||statOpts[k])+'</option>';
  }
  statSel+='</select>';
  head.style.display='';
  head.innerHTML='<div class="ibx-convo-head__row">'
    +'<h3>'+esc(thread.subject||'(no subject)')+'</h3>'
    +(thread.primary_category?'<span class="ibx-tag cat">'+esc(thread.primary_category)+'</span>':'')
    +'<span class="ibx-spacer"></span>'
    +statSel
    +'</div>'
    +'<p class="muted" style="margin:4px 0 0;font-size:12px">'+esc((contact&&contact.name)?(contact.name+' <'+(thread.contact_email||'')+'>'):(thread.contact_email||''))+'</p>';
  var ss=el('inbox-status-sel'); if(ss) ss.onchange=function(){ saveInboxStatus(tid); };
  // Timeline: inbound left / outbound right (tinted), in received order, with a
  // day divider whenever the (UTC) calendar date changes (Phase 4 polish).
  var msgHtml='', lastDay='';
  for(var i=0;i<messages.length;i++){
    var m=messages[i];
    var day=(m.received_at||'').slice(0,10);
    if(day&&day!==lastDay){ msgHtml+='<div class="ibx-day">'+esc(ibxDayLabel(m.received_at))+'</div>'; lastDay=day; }
    var isOut=m.direction==='outbound';
    var dir=isOut?'You → '+esc(m.to_addr||''):esc(m.from_addr||'');
    var ts=m.received_at?esc(m.received_at.slice(0,16).replace('T',' ')):'';
    msgHtml+='<div class="ibx-bubble '+(isOut?'out':'in')+'">'
      +'<div class="ibx-bubble__hdr">'+dir+(ts?' · '+ts:'')+'</div>'
      +'<div class="ibx-bubble__body">'+esc(m.body_text||'(no body)')+'</div>'
      +'</div>';
  }
  // Template picker: swaps the pending draft for a canonical server-rendered
  // template (partnership screening questions, declines, holding note) without
  // leaving the Inbox. Keys/labels mirror DRAFT_TEMPLATES on the server -
  // console.test.ts pins the two lists together. Applying never sends.
  var tplSel='<select id="inbox-tpl-sel" class="ibx-tpl-sel" aria-label="Replace draft with a template">'
    +'<option value="">Use a template…</option>'
    +'<option value="qualifying">Partnership screening questions</option>'
    +'<option value="voucher_invite">Trial invite (code on its way)</option>'
    +'<option value="partnership_decline">Partnership decline</option>'
    +'<option value="service_decline">Service pitch decline</option>'
    +'<option value="operations_decline">Internal operations decline</option>'
    +'<option value="keep_to_email">Keep to email (decline WhatsApp)</option>'
    +'<option value="holding_ack">Holding note (we are reviewing)</option>'
    +'</select>';
  // Pending draft: distinct dashed card at the END of the timeline
  var draftHtml='';
  if(draft&&draft.id){
    var confChip=(draft.confidence!=null)?'<span class="ibx-tag">'+esc(String(draft.confidence))+'% confident</span>':'';
    var draftedChip=draft.created_at?'<span class="ibx-tag">drafted '+esc(ibxRelAge(draft.created_at))+' ago</span>':'';
    var dept=thread.primary_category?'<span class="ibx-tag">'+esc(ibxAgentName(thread.primary_category))+'</span>':'';
    var holdChips='';
    var holds=ibxHoldReasons(draft);
    for(var h=0;h<holds.length;h++) holdChips+='<span class="ibx-tag no">'+esc(holds[h])+'</span>';
    draftHtml='<div class="ibx-draft" id="ibx-draft-card">'
      +'<div class="ibx-draft__hdr"><span class="ibx-draft__title">DRAFT - not sent</span>'+confChip+draftedChip+dept+holdChips+'</div>'
      +'<div id="inbox-draft" class="ibx-draft-body" contenteditable="true" spellcheck="true">'+esc(draft.body_text||'')+'</div>'
      +'<div class="ibx-draft__actions">'
      +'<button id="inbox-approve-btn" type="button">Approve &amp; send</button>'
      +'<button id="inbox-regen-btn" class="ghost" type="button">Regenerate</button>'
      +tplSel
      +'</div>'
      +'</div>';
  } else {
    // No pending draft: the picker still works - it CREATES a pending draft
    // from the template, so a processed thread can be reopened with the right
    // canned reply instead of pasting copy in from outside.
    draftHtml='<div class="ibx-note">No draft pending '+tplSel+'</div>';
  }
  tl.innerHTML=msgHtml+draftHtml;
  tl.scrollTop=tl.scrollHeight;
  if(draft&&draft.id){
    var draftId=draft.id;
    var appBtn=el('inbox-approve-btn');
    if(appBtn) appBtn.onclick=function(){ approveDraftAction(draftId,tid); };
    var regenBtn=el('inbox-regen-btn');
    if(regenBtn) regenBtn.onclick=function(){ regenerateDraftAction(draftId,tid); };
  }
  var tplEl=el('inbox-tpl-sel');
  if(tplEl) tplEl.onchange=function(){ if(tplEl.value) applyTemplateAction(tplEl.value,tid); };
  renderInboxContext(thread,labels,draft,invoice,applicant,contact,partnerPool,partnerConsent,events);
}
// Context rail: ONLY data the thread GET actually returns (thread fields, labels,
// contact row, draft hold reasons, applicant screening, invoice, partner pool
// state + marketing consent, email events) - nothing fabricated.
function renderInboxContext(thread,labels,draft,invoice,applicant,contact,partnerPool,partnerConsent,events){
  var ctx=el('ibx-context-body'); if(!ctx) return;
  var tid=thread.id;
  var cust='<div class="ibx-ctx-block"><h4>Customer</h4>'
    +((contact&&contact.name)?'<p style="margin:0 0 2px;font-weight:600">'+esc(contact.name)+'</p>':'')
    +'<p style="margin:0;font-weight:'+((contact&&contact.name)?'400':'600')+';word-break:break-all;font-size:12.5px">'+esc(thread.contact_email||'')+'</p>';
  if(contact&&contact.message_count!=null){
    cust+='<p class="muted" style="margin:6px 0 0;font-size:12px">Messages on file: '+esc(String(contact.message_count))+'</p>';
  }
  if(thread.declared_intent){
    var DMAP={order:'Order help',partnerships:'Creator / affiliate partnership',wholesale:'Wholesale / bulk order'};
    cust+='<p class="muted" style="margin:6px 0 0;font-size:12px">Declared: <strong>'+esc(DMAP[thread.declared_intent]||thread.declared_intent)+'</strong></p>';
  }
  if(thread.intent_score!=null) cust+='<p class="muted" style="margin:6px 0 0;font-size:12px">Intent score: '+esc(String(thread.intent_score))+'/100</p>';
  if(thread.summary) cust+='<p class="muted" style="margin:6px 0 0;font-size:12px">'+esc(thread.summary)+'</p>';
  cust+='</div>';
  var labOpts=['lead','product-question','order-status','shipping-returns','wholesale-b2b','affiliate','complaint','spam','automated','other'];
  var labSel='<select id="inbox-label-sel" multiple size="5" style="width:100%;font-size:13px">';
  for(var j=0;j<labOpts.length;j++){
    labSel+='<option value="'+esc(labOpts[j])+'"'+(labels.indexOf(labOpts[j])>=0?' selected':'')+'>'+esc(labOpts[j])+'</option>';
  }
  labSel+='</select>';
  var labBlock='<div class="ibx-ctx-block"><h4>Labels</h4>'+labSel
    +'<div class="row" style="margin-top:8px"><button id="inbox-save-labels" class="ghost" type="button">Save labels</button></div></div>';
  // Email engagement: what happened to OUR sends on this thread (delivered /
  // opened / clicked / bounced), newest first. Events arrive via the Resend
  // webhook keyed by the send-time thread_id tag; block omitted when none.
  var evBlock='';
  if(events&&events.length){
    var evRows='';
    for(var ei=0;ei<events.length;ei++){
      var ev=events[ei];
      var bad=(ev.eventType==='bounced'||ev.eventType==='complained');
      var what=ev.eventType.charAt(0).toUpperCase()+ev.eventType.slice(1);
      evRows+='<div class="ibx-ev'+(bad?' bad':'')+'"><span class="ibx-ev-what">'+esc(what)+'</span>'
        +'<span class="ibx-ev-when">'+esc(ibxRelAge(ev.occurredAt))+' ago</span>'
        +(ev.link?('<span class="ibx-ev-link">'+esc(ev.link)+'</span>'):'')
        +'</div>';
    }
    evBlock='<div class="ibx-ctx-block"><h4>Email engagement</h4>'+evRows+'</div>';
  }
  var holdBlock='';
  if(draft&&draft.id){
    var holds=ibxHoldReasons(draft);
    holdBlock='<div class="ibx-ctx-block"><h4>Draft holds</h4>'
      +(holds.length
        ?holds.map(function(hh){ return '<span class="ibx-tag no" style="margin:0 4px 4px 0">'+esc(hh)+'</span>'; }).join('')
        :'<p class="muted" style="margin:0;font-size:12px">None - clear to send.</p>')
      +'</div>';
  }
  var partnerBlock='';
  if((applicant&&applicant.stage)||labels.indexOf('affiliate')>=0||thread.declared_intent==='partnerships'){
    var screenHtml='';
    if(applicant&&applicant.stage){
      var v=null; try{ v=applicant.verdict_json?JSON.parse(applicant.verdict_json):null; }catch(e0){}
      var reasons=(v&&v.reasons&&v.reasons.length)?esc(v.reasons.join(' · ')):'';
      screenHtml='<p style="font-size:13px;margin:0">Stage: <strong>'+esc(applicant.stage)+'</strong>'+((applicant.score!=null)?' · score '+esc(String(applicant.score))+'/12':'')+'</p>'
        +(reasons?'<p class="muted" style="font-size:12px;margin:4px 0 0">'+reasons+'</p>':'');
    } else {
      screenHtml='<p class="muted" style="font-size:12px;margin:0">No screening record on this thread.</p>';
    }
    // Trial-code queue control: park a qualified applicant so their code can be
    // issued later from Partners. Sends nothing; state comes from the thread GET.
    var poolHtml='';
    if(partnerPool==='live'){
      poolHtml='<p style="margin:8px 0 0"><span class="prt-chip prt-live">partner with a live code</span></p>';
    } else if(partnerPool==='queued'){
      poolHtml='<p style="margin:8px 0 0"><span class="prt-chip prt-expired">in the trial code queue</span></p>'
        +'<p class="muted" style="font-size:12px;margin:4px 0 0">Issue their code from the Partners view when you are ready; the invite email will be staged back on this thread.</p>';
    } else {
      poolHtml='<div class="row" style="margin-top:8px"><button id="inbox-queue-btn" class="ghost" type="button">Add to trial code queue</button></div>'
        +'<p class="muted" style="font-size:12px;margin:4px 0 0">Parks them in Partners so you can issue the code later. Sends nothing now.</p>';
    }
    // Partner updates opt-in: the invite paragraph asks them to "just say yes
    // in your reply", so the switch sits where the yes arrives. Flip it ONLY on
    // their own yes - correspondence alone never joins the campaign list.
    var conHtml='';
    if(partnerConsent===true){
      conHtml='<p style="margin:10px 0 0"><span class="prt-chip prt-live">partner updates: opted in</span></p>'
        +'<div class="row" style="margin-top:6px"><button id="inbox-consent-btn" class="ghost" type="button" data-consent-on="0">Remove updates opt-in</button></div>';
    } else {
      conHtml='<div class="row" style="margin-top:10px"><button id="inbox-consent-btn" class="ghost" type="button" data-consent-on="1">Mark updates opt-in</button></div>'
        +'<p class="muted" style="font-size:12px;margin:4px 0 0">Only when they have themselves said yes to partner updates in this conversation.</p>';
    }
    partnerBlock='<div class="ibx-ctx-block"><h4>Partnership screening</h4>'+screenHtml+poolHtml+conHtml+'</div>';
  }
  // Invoice: open-invoice card, or the builder when none is open
  var invoiceBlock='';
  if(invoice&&invoice.id){
    var invItems=[];
    try{ invItems=JSON.parse(invoice.line_items_json||'[]'); }catch(e2){}
    var invRows=invItems.map(function(li){
      return '<tr><td>'+esc(li.title||'')+'</td><td style="text-align:right">'+esc(String(li.qty||1))+'</td><td style="text-align:right">£'+esc(Number(li.priceGbp||0).toFixed(2))+'</td></tr>';
    }).join('');
    var invUrlHtml='';
    if(invoice.status==='sent'&&invoice.invoice_url){
      invUrlHtml='<p style="margin:8px 0 0"><a href="'+esc(invoice.invoice_url)+'" target="_blank" rel="noopener noreferrer" style="color:var(--ok-ink)">Open invoice link ↗</a></p>';
    }
    invoiceBlock='<div class="ibx-ctx-block"><h4>Invoice <span class="badge '+(invoice.status==='sent'?'ok':'no')+'">'+esc(invoice.status)+'</span></h4>'
      +'<table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr><th style="text-align:left">Item</th><th style="text-align:right">Qty</th><th style="text-align:right">Price</th></tr></thead><tbody>'+invRows+'</tbody></table>'
      +'<p style="margin:8px 0 0;font-weight:600">Total: £'+esc(Number(invoice.total||0).toFixed(2))+'</p>'
      +invUrlHtml
      +'<div class="row" style="margin-top:8px"><button id="inbox-invoice-discard-btn" class="ghost" type="button">Discard invoice</button></div>'
      +'</div>';
  } else {
    invoiceBlock='<div class="ibx-ctx-block"><h4>Build invoice</h4>'
      +'<div style="margin-bottom:6px"><label for="inbox-catalog-q" style="font-size:12px">Search catalog</label><input id="inbox-catalog-q" type="text" placeholder="e.g. harness" autocomplete="off" spellcheck="false"></div>'
      +'<button id="inbox-catalog-search-btn" class="ghost" type="button" style="width:100%;margin-bottom:6px">Search</button>'
      +'<div id="inbox-catalog-results" style="margin-bottom:8px;font-size:13px;color:var(--subdued)"></div>'
      +'<div id="inbox-invoice-items" style="font-size:13px;margin-bottom:8px"></div>'
      +'<div style="margin-bottom:6px"><label for="inbox-invoice-cover" style="font-size:12px">Cover note (optional)</label><textarea id="inbox-invoice-cover" style="width:100%;min-height:60px;padding:9px 11px;border:1px solid var(--field-border);border-radius:8px;background:var(--field);color:var(--ink);font-size:13px;font-family:inherit;resize:vertical" placeholder="e.g. Here is the invoice for the items we discussed."></textarea></div>'
      +'<button id="inbox-invoice-build-btn" type="button" style="width:100%">Approve &amp; send invoice</button>'
      +'<p id="inbox-invoice-msg" class="msg muted"></p>'
      +'</div>';
  }
  ctx.innerHTML=cust+evBlock+labBlock+holdBlock+partnerBlock+invoiceBlock;
  var slb=el('inbox-save-labels'); if(slb) slb.onclick=function(){ saveInboxLabels(tid); };
  var qb=el('inbox-queue-btn'); if(qb) qb.onclick=function(){ queuePartnerAction(tid); };
  var cb=el('inbox-consent-btn'); if(cb) cb.onclick=function(){ threadConsentAction(tid,cb.getAttribute('data-consent-on')==='1'); };
  if(invoice&&invoice.id){
    var invDiscBtn=el('inbox-invoice-discard-btn');
    if(invDiscBtn) invDiscBtn.onclick=function(){ discardInvoiceAction(invoice.id,tid); };
  } else {
    var csb=el('inbox-catalog-search-btn'); if(csb) csb.onclick=function(){ runCatalogSearch(tid); };
    var ibb=el('inbox-invoice-build-btn'); if(ibb) ibb.onclick=function(){ buildInvoiceAction(tid); };
    renderInvoiceItems();
  }
}
// --- Draft actions ---
// Approve sends the CURRENT edited text: the contenteditable's innerText is
// passed as the body override ({id, body} - approveDraft uses it when non-empty).
async function approveDraftAction(draftId,threadId){
  var d=el('inbox-draft');
  var body=d?d.innerText:'';
  var appBtn=el('inbox-approve-btn'); if(appBtn) appBtn.disabled=true;
  setMsg('ibx-msg','Sending…','muted');
  try{
    var r=await api('/inbox/approve',{id:draftId,body:body});
    if(r.ok){
      inboxDraftOriginal='';
      openInboxThread(threadId);  // re-render: the sent reply joins the timeline
      loadInboxThreads();         // processed thread drops off the Open filter
      loadGlance();               // pending-draft count changed: refresh KPIs + rail badge
      setMsg('ibx-msg','Sent ✓ - moved to Awaiting customer.','ok');
    } else { setMsg('ibx-msg','Failed: '+(r.error||'unknown error'),'no'); if(appBtn) appBtn.disabled=false; }
  }catch(e){ setMsg('ibx-msg','Failed: '+errText(e),'no'); if(el('inbox-approve-btn')) el('inbox-approve-btn').disabled=false; }
}
async function regenerateDraftAction(draftId,threadId){
  var regenBtn=el('inbox-regen-btn'); if(regenBtn) regenBtn.disabled=true; // disabled BEFORE the await - guards double-click
  var appBtn=el('inbox-approve-btn'); if(appBtn) appBtn.disabled=true;
  setMsg('ibx-msg','Regenerating…','muted');
  try{
    var r=await api('/inbox/regenerate',{id:draftId});
    if(r.ok){ inboxDraftOriginal=''; openInboxThread(threadId); setMsg('ibx-msg','Regenerated ✓','ok'); }
    else { setMsg('ibx-msg','Failed: '+(r.error||'unknown error'),'no'); if(regenBtn) regenBtn.disabled=false; if(appBtn) appBtn.disabled=false; }
  }catch(e){ setMsg('ibx-msg','Failed: '+errText(e),'no'); if(el('inbox-regen-btn')) el('inbox-regen-btn').disabled=false; if(el('inbox-approve-btn')) el('inbox-approve-btn').disabled=false; }
}
// Replace (or create) the pending draft from a canonical template. The server
// renders the body (salutation, funnel marker, applicant bookkeeping), so the
// result behaves exactly as if the funnel had drafted it. Never sends: the
// thread re-renders with the template as an editable pending draft.
async function applyTemplateAction(key,threadId){
  var sel=el('inbox-tpl-sel'); if(sel) sel.disabled=true;
  var appBtn=el('inbox-approve-btn'); if(appBtn) appBtn.disabled=true;
  var regenBtn=el('inbox-regen-btn'); if(regenBtn) regenBtn.disabled=true;
  setMsg('ibx-msg','Applying the template…','muted');
  try{
    var r=await api('/inbox/template',{threadId:threadId,template:key});
    if(r.ok){ inboxDraftOriginal=''; openInboxThread(threadId); setMsg('ibx-msg','Template applied - review, edit if needed, then Approve to send.','ok'); }
    else {
      setMsg('ibx-msg','Failed: '+(r.error||'unknown error'),'no');
      if(sel){ sel.disabled=false; sel.value=''; }
      if(appBtn) appBtn.disabled=false;
      if(regenBtn) regenBtn.disabled=false;
    }
  }catch(e){
    setMsg('ibx-msg','Failed: '+errText(e),'no');
    var s2=el('inbox-tpl-sel'); if(s2){ s2.disabled=false; s2.value=''; }
    if(el('inbox-approve-btn')) el('inbox-approve-btn').disabled=false;
    if(el('inbox-regen-btn')) el('inbox-regen-btn').disabled=false;
  }
}
// --- Thread controls ---
async function saveInboxStatus(id){
  var sel=el('inbox-status-sel'); if(!sel) return;
  var status=sel.value;
  setMsg('ibx-msg','Saving status…','muted');
  try{
    var r=await api('/inbox/status',{id:id,status:status});
    if(r.ok){ setMsg('ibx-msg','Status updated to '+(IBX_STATUS_LABELS[status]||status)+'.','ok'); loadInboxThreads(); }
    else setMsg('ibx-msg','Failed: '+(r.error||'unknown error'),'no');
  }catch(e){ setMsg('ibx-msg','Failed: '+errText(e),'no'); }
}
// Trial-code queue: one click parks this sender in Partners (status queued) so
// their code can be issued later. No email, no Shopify object - just bookkeeping.
async function queuePartnerAction(tid){
  var qb=el('inbox-queue-btn'); if(qb) qb.disabled=true;
  setMsg('ibx-msg','Adding to the trial code queue…','muted');
  try{
    var r=await api('/inbox/queue-partner',{threadId:tid});
    if(!r.ok){ setMsg('ibx-msg','Failed: '+(r.error||'unknown error'),'no'); if(qb) qb.disabled=false; return; }
    if(r.state==='live_partner') setMsg('ibx-msg','This person already has a live code - see the Partners view.','ok');
    else setMsg('ibx-msg','Queued. Issue their code from the Partners view whenever you are ready; the invite email carrying the code will be staged back on this thread.','ok');
    openInboxThread(tid);
  }catch(e){ setMsg('ibx-msg','Failed: '+errText(e),'no'); if(qb) qb.disabled=false; }
}
// Marketing opt-in flipped from the thread where the yes arrived. Consent
// only - it can never queue, graduate or end a partner.
async function threadConsentAction(tid,on){
  var cb=el('inbox-consent-btn'); if(cb) cb.disabled=true;
  setMsg('ibx-msg',on?'Recording their opt-in…':'Removing the opt-in…','muted');
  try{
    var r=await api('/inbox/partner-consent',{threadId:tid,on:on});
    if(!r.ok){ setMsg('ibx-msg','Failed: '+(r.error||'unknown error'),'no'); if(cb) cb.disabled=false; return; }
    setMsg('ibx-msg',on?'Opted in. They are now part of the Campaigns partner audience.':'Opt-in removed. They are off the partner updates list.','ok');
    openInboxThread(tid);
  }catch(e){ setMsg('ibx-msg','Failed: '+errText(e),'no'); if(cb) cb.disabled=false; }
}
async function saveInboxLabels(id){
  var sel=el('inbox-label-sel');
  if(!sel){ setMsg('ibx-msg','Label selector not found.','no'); return; }
  var chosen=[];
  for(var i=0;i<sel.options.length;i++){ if(sel.options[i].selected) chosen.push(sel.options[i].value); }
  setMsg('ibx-msg','Saving labels…','muted');
  try{
    var r=await api('/inbox/labels',{id:id,labels:chosen});
    if(r.ok){ setMsg('ibx-msg','Labels saved.','ok'); }
    else { setMsg('ibx-msg','Failed: '+(r.error||'unknown error'),'no'); }
  }catch(e){ setMsg('ibx-msg','Failed: '+errText(e),'no'); }
}
// --- Invoice builder (context rail) ---
// Uses POST (consistent with api()) - the route is /api/inbox/catalog, POST {q}.
function renderInvoiceItems(){
  var box=el('inbox-invoice-items');
  if(!box) return;
  if(!inboxInvoiceItems.length){ box.innerHTML='<span class="muted">No items added yet.</span>'; return; }
  var rows=inboxInvoiceItems.map(function(item,idx){
    return '<div class="row" style="margin-bottom:4px">'
      +'<span class="grow">'+esc(item.title)+'</span>'
      +'<input type="number" min="1" max="99" value="'+esc(String(item.qty))+'" style="width:64px" data-inv-qty="'+idx+'">'
      +'<span style="width:70px;text-align:right">£'+esc(Number(item.priceGbp||0).toFixed(2))+'</span>'
      +'<button class="ghost" type="button" style="padding:4px 8px" data-inv-rm="'+idx+'">✕</button>'
      +'</div>';
  }).join('');
  box.innerHTML=rows;
  var qtyInputs=box.querySelectorAll('input[data-inv-qty]');
  for(var qi=0;qi<qtyInputs.length;qi++){
    (function(inp,i){ inp.onchange=function(){ var v=Math.max(1,parseInt(inp.value,10)||1); inboxInvoiceItems[i].qty=v; inp.value=v; }; })(qtyInputs[qi],Number(qtyInputs[qi].getAttribute('data-inv-qty')));
  }
  var rmBtns=box.querySelectorAll('button[data-inv-rm]');
  for(var ri=0;ri<rmBtns.length;ri++){
    (function(btn){ btn.onclick=function(){ inboxInvoiceItems.splice(Number(btn.getAttribute('data-inv-rm')),1); renderInvoiceItems(); }; })(rmBtns[ri]);
  }
}
async function runCatalogSearch(threadId){
  var qEl=el('inbox-catalog-q'); var q=(qEl&&qEl.value.trim())||'';
  if(!q) return;
  var resEl=el('inbox-catalog-results');
  if(resEl) resEl.textContent='Searching…';
  try{
    var r=await api('/inbox/catalog',{q:q});
    if(r.ok===false&&r.error==='reconnect_required'){
      showReconnectBanner(); if(resEl) resEl.textContent=''; return;
    }
    if(!r.ok){ if(resEl) resEl.textContent='Search failed: '+(r.error||'unknown'); return; }
    var variants=r.variants||[];
    if(!variants.length){ if(resEl) resEl.textContent='No products found.'; return; }
    if(resEl){
      resEl.innerHTML='';
      variants.slice(0,12).forEach(function(v){
        var btn=document.createElement('button');
        btn.className='ghost'; btn.type='button';
        btn.style.cssText='display:block;width:100%;text-align:left;margin-bottom:4px;font-size:13px;white-space:normal';
        btn.textContent='+ '+v.title+(v.variantTitle&&v.variantTitle!==v.title?' / '+v.variantTitle:'')+(v.priceGbp?' · £'+Number(v.priceGbp).toFixed(2):'');
        btn.onclick=function(){
          inboxInvoiceItems.push({variantId:v.variantId,title:(v.title+(v.variantTitle&&v.variantTitle!==v.title?' / '+v.variantTitle:'')),qty:1,priceGbp:v.priceGbp||0});
          renderInvoiceItems();
        };
        resEl.appendChild(btn);
      });
    }
  }catch(e){ if(resEl) resEl.textContent='Search failed: '+errText(e); }
}
async function buildInvoiceAction(threadId){
  var msgEl=el('inbox-invoice-msg');
  if(!inboxInvoiceItems.length){ if(msgEl) setMsg('inbox-invoice-msg','Add at least one item.','no'); return; }
  var coverEl=el('inbox-invoice-cover');
  var coverText=(coverEl&&coverEl.value.trim())||'';
  var btn=el('inbox-invoice-build-btn'); if(btn) btn.disabled=true;
  if(msgEl) setMsg('inbox-invoice-msg','Building invoice…','muted');
  try{
    var items=inboxInvoiceItems.map(function(it){ return {variantId:it.variantId,qty:it.qty}; });
    var r=await api('/inbox/invoice/build',{threadId:threadId,items:items,coverText:coverText});
    if(r.ok===false&&r.error==='reconnect_required'){
      showReconnectBanner(); if(msgEl) setMsg('inbox-invoice-msg','Re-authorise required - see banner above.','no');
      if(btn) btn.disabled=false; return;
    }
    if(!r.ok){ if(msgEl) setMsg('inbox-invoice-msg','Failed: '+(r.error||'unknown error'),'no'); if(btn) btn.disabled=false; return; }
    inboxInvoiceItems=[];
    openInboxThread(threadId);
    setMsg('ibx-msg','Invoice sent ✓','ok');
  }catch(e){ if(msgEl) setMsg('inbox-invoice-msg','Failed: '+errText(e),'no'); if(btn) btn.disabled=false; }
}
async function discardInvoiceAction(invoiceId,threadId){
  setMsg('ibx-msg','Discarding invoice…','muted');
  var btn=el('inbox-invoice-discard-btn'); if(btn) btn.disabled=true;
  try{
    var r=await api('/inbox/invoice/discard',{invoiceId:invoiceId});
    if(!r.ok){ setMsg('ibx-msg','Failed: '+(r.error||'unknown error'),'no'); if(btn) btn.disabled=false; return; }
    openInboxThread(threadId);
    setMsg('ibx-msg','Invoice discarded.','muted');
  }catch(e){ setMsg('ibx-msg','Failed: '+errText(e),'no'); if(btn) btn.disabled=false; }
}
function showReconnectBanner(){
  var banner=el('inbox-reconnect-banner');
  if(!banner) return;
  var shop=(new URL(location.href)).searchParams.get('shop')||'';
  var href='/auth'+(shop?'?shop='+encodeURIComponent(shop):'');
  banner.style.display='';
  banner.innerHTML='Re-authorisation required. <a href="'+esc(href)+'" style="color:var(--no-ink);font-weight:600">Click here to reconnect ↗</a>';
}
`;
