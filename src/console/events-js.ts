// Events view browser JS. Same template-literal rules as the other view JS:
// no backticks or dollar-brace, '+' concat, esc() every dynamic value, armed
// buttons for consequential actions (prtArm from partners-js, same document).
// The one-off create/end handlers moved here from campaigns-js when the
// Storewide event card moved into this view (2026-07-06).
export const eventsJs = `
// --- Events: live/scheduled promos from the Shopify probe, as grid cards ---
function evPromoCard(p){
  var status=p.status==='ACTIVE'
    ?'<span class="prt-chip prt-live">running</span>'
    :'<span class="prt-chip prt-expired">scheduled</span>';
  // Both ends of the window (owner, 2026-09-05): "ends 30/08/2027" alone reads
  // as a promotion running continuously until then.
  var starts=p.startsAt?((p.status==='ACTIVE'?'started ':'starts ')+esc(prtWhen(p.startsAt))+', '):'';
  var when=(p.percentage!=null?(esc(p.percentage)+'% off, '):'')
    +starts
    +(p.endsAt?('ends '+esc(prtWhen(p.endsAt))):'no end date');
  var h='<div class="evr-card'+(p.status==='ACTIVE'?' is-on':'')+'">'
    +'<div class="evr-head"><strong>'+esc(p.title)+'</strong>'
    +(p.code?'<span class="prt-code">'+esc(p.code)+'</span>':'')
    +status+'</div>'
    +'<div class="evr-when">'+when+'</div>';
  if(p.source==='code'&&p.code&&p.status==='ACTIVE')
    h+='<div class="evr-actions"><button class="ghost" type="button" data-ev-end="'+esc(p.code)+'">End now</button></div>';
  return h+'</div>';
}
async function evLoad(){
  var box=el('ev-promos'); if(!box) return;
  try{
    var r=await api('/partners/discount-status',{});
    if(!r.ok||!r.scope){ box.textContent='Event check unavailable'+((r&&r.note)?(': '+r.note):'.'); return; }
    if(!r.promos.length){ box.textContent='No storewide event is running or scheduled.'; return; }
    var parts=[];
    for(var i=0;i<r.promos.length;i++) parts.push(evPromoCard(r.promos[i]));
    box.innerHTML='<div class="evr-grid">'+parts.join('')+'</div>';
  }catch(e){ box.textContent='Event check unavailable.'; }
}
// --- Yearly (recurring) events: catalogue cards + enable/disable ---
function evRecCard(ev){
  var win=prtWhen(ev.nextStartsAt)+' to '+prtWhen(ev.nextEndsAt);
  var head=esc(ev.headline.replace('{pct}',String(ev.pctOff)));
  var chips='';
  for(var i=0;i<ev.chips.length;i++) chips+='<span class="evr-chip">'+esc(ev.chips[i])+'</span>';
  var status=ev.enabled
    ?'<span class="prt-chip prt-live">'+(ev.running?'running now':'enabled, runs every year')+'</span>'
    :'<span class="prt-chip prt-expired">off</span>';
  return '<div class="evr-card'+(ev.enabled?' is-on':'')+'">'
    +'<div class="evr-head"><strong>'+esc(ev.name)+'</strong><span class="prt-code">'+esc(ev.code)+'</span>'+status+'</div>'
    +'<div class="evr-when">Next occurrence: '+esc(win)+'</div>'
    +'<div class="evr-preview">'+head+'<span class="evr-sub">'+esc(ev.subline)+'</span><div class="evr-chips">'+chips+'</div></div>'
    +'<div class="evr-actions">'
    +'<label>Discount % <input type="number" min="1" max="90" step="0.5" value="'+esc(ev.pctOff)+'" data-ev-pct="'+esc(ev.key)+'"'+(ev.enabled?' disabled':'')+'></label>'
    +(ev.enabled
      ?'<button class="ghost" type="button" data-ev-off="'+esc(ev.key)+'">Disable</button>'
      :'<button type="button" data-ev-on="'+esc(ev.key)+'">Enable</button>')
    +'</div></div>';
}
async function evRecLoad(){
  var box=el('ev-recurring'); if(!box) return;
  try{
    var r=await api('/events/recurring',{});
    if(!r.ok){ box.innerHTML='<p class="msg no">Could not load the yearly events.</p>'; return; }
    var h='';
    for(var i=0;i<r.events.length;i++) h+=evRecCard(r.events[i]);
    box.innerHTML='<div class="evr-grid">'+h+'</div>';
  }catch(e){ box.innerHTML='<p class="msg no">Could not load the yearly events.</p>'; }
}
async function evRecToggle(key,on){
  var body={key:key,enabled:on};
  var inp=document.querySelector('input[data-ev-pct="'+key+'"]');
  if(on&&inp&&inp.value) body.pctOff=Number(inp.value);
  setMsg('ev-rec-msg',on?'Enabling and scheduling in Shopify…':'Disabling…','muted');
  try{
    var r=await api('/events/recurring/toggle',body);
    if(!r.ok){ setMsg('ev-rec-msg','Failed: '+(r.error||'unknown error'),'no'); return; }
    setMsg('ev-rec-msg',on
      ?('Enabled. The next occurrence is scheduled in Shopify ('+prtWhen(r.window.startsAt)+' to '+prtWhen(r.window.endsAt)+') and re-arms itself every year from now on. The announcement draft appears in Campaigns about two weeks before it starts.')
      :'Disabled. The scheduled discount was retired; the card stays ready to re-enable.','ok');
    evRecLoad(); evLoad();
  }catch(e){ setMsg('ev-rec-msg','Action failed.','no'); }
}
// --- One-off event create/end (the Shopify discount is the only record) ---
async function evCreate(btn){
  if(!prtArm(btn,'Click again to create the event')) return;
  var body={
    code:el('ev-code').value.trim().toUpperCase(),
    pctOff:Number(el('ev-pct').value),
    startDate:el('ev-start').value,
    endDate:el('ev-end').value,
    stageCampaign:!!el('ev-stage-chk').checked
  };
  setMsg('ev-msg','Creating the event in Shopify…','muted');
  try{
    var r=await api('/event/create',body);
    if(!r.ok){ setMsg('ev-msg','Failed: '+(r.error||'unknown error'),'no'); return; }
    var msg='Created '+r.code+'. It works at checkout only between '+prtWhen(r.startsAt)+' and '+prtWhen(r.endsAt)+' - the schedule lives inside the discount, and the storefront pop-up follows it automatically.';
    if(r.campaignId) msg+=' The announcement draft is in Campaigns: review, send yourself a test, then send.';
    setMsg('ev-msg',msg,'ok');
    el('ev-code').value='';
    evLoad(); loadCampaigns();
  }catch(e){ setMsg('ev-msg','Could not create the event.','no'); }
}
async function evEnd(code){
  try{
    var r=await api('/event/end',{code:code});
    if(!r.ok){ setMsg('ev-msg','Failed: '+(r.error||'unknown error'),'no'); return; }
    setMsg('ev-msg','Ended. The code is deactivated in Shopify immediately and the storefront pop-up clears within about 10 minutes.','ok');
    evLoad(); evRecLoad();
  }catch(e){ setMsg('ev-msg','Could not end the event.','no'); }
}
(function(){
  var strip=el('ev-promos');
  if(strip) strip.addEventListener('click',function(e){
    var t=e.target;
    if(!t||!t.getAttribute) return;
    var code=t.getAttribute('data-ev-end');
    if(code&&prtArm(t,'Click again to end the event')) evEnd(code);
  });
  var rec=el('ev-recurring');
  if(rec) rec.addEventListener('click',function(e){
    var t=e.target;
    if(!t||!t.getAttribute) return;
    var key=t.getAttribute('data-ev-on');
    if(key&&prtArm(t,'Click again to enable')) evRecToggle(key,true);
    if(key) return;
    key=t.getAttribute('data-ev-off');
    if(key&&prtArm(t,'Click again to disable')) evRecToggle(key,false);
  });
  evLoad();
  evRecLoad();
})();
`;
