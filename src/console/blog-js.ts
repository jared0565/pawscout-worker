// Content view browser JS. Same template-literal rules as the other *-js
// modules: browser JS inside a TS template literal - no backticks or
// dollar-brace, '+' concatenation, esc() every dynamic value.
export const blogJs = `
// --- Content: blog agents author DRAFT posts (the system authors; a human publishes) ---
// Topic suggestions: researched picks, each already backed by in-stock products.
// The chosen candidate carries its full brief into generation (no re-research).
var blgCandidates=[]; var blgChosen=null;
async function blogSuggest(){
  var btn=el('blg-suggest-btn'); if(btn) btn.disabled=true;
  setMsg('blg-msg','Researching topics grounded in your live, in-stock products. This can take a moment.','muted');
  try{
    var r=await api('/blog/topics',{});
    if(!r.ok||!r.candidates||!r.candidates.length){ setMsg('blg-msg','No topic suggestions right now: '+esc((r&&r.error)||'none found'),'no'); if(btn) btn.disabled=false; return; }
    blgCandidates=r.candidates;
    var sel=el('blg-suggest');
    if(sel){
      sel.innerHTML='';
      for(var i=0;i<blgCandidates.length;i++){
        var c=blgCandidates[i];
        var o=document.createElement('option');
        o.value=String(i);
        o.textContent=c.brief.title+'  ['+c.collectionTitle+', '+c.liveProductCount+' in stock]';
        sel.appendChild(o);
      }
      sel.style.display='';
    }
    blgChosen=blgCandidates[0];
    if(el('blg-topic')) el('blg-topic').value=blgChosen.brief.title;
    setMsg('blg-msg','Researched '+blgCandidates.length+' topic(s), each backed by in-stock products. Pick one (or edit the field), then Draft a new post.','ok');
  }catch(e){ setMsg('blg-msg','Could not research topics: '+errText(e),'no'); }
  if(btn) btn.disabled=false;
}
function blogPickSuggested(){
  var sel=el('blg-suggest'); if(!sel) return;
  var i=parseInt(sel.value,10);
  if(isNaN(i)||!blgCandidates[i]) return;
  blgChosen=blgCandidates[i];
  if(el('blg-topic')) el('blg-topic').value=blgChosen.brief.title;
}
function blgTopicEdited(){ blgChosen=null; } // typing over a suggestion = freehand topic
function blgItemHtml(p){
  var flags=[]; try{ flags=JSON.parse(p.claim_flags_json||'[]'); }catch(e){}
  var related=[]; try{ related=JSON.parse(p.related_handles_json||'[]'); }catch(e){}
  var h='<div class="blg-item">'
    +'<div class="blg-item-head"><span class="blg-item-title">'+esc(p.title)+'</span>'
    +'<span class="badge '+(p.status==='published'?'ok':'muted')+'">'+esc(p.status)+'</span></div>';
  if(p.collection_handle) h+='<div class="blg-meta">Funnels to /collections/'+esc(p.collection_handle)+'</div>';
  if(flags.length){
    var concerns={}; for(var j=0;j<flags.length;j++){ concerns[flags[j].concern]=1; }
    h+='<div class="blg-flags">'+flags.length+' line(s) to verify before publishing ('+esc(Object.keys(concerns).join(', '))+').</div>';
  }
  if(related.length){
    h+='<div class="blg-meta">Shop this guide: '+related.length+' product(s)'+(p.hero_source_handle?', hero from '+esc(p.hero_source_handle):'')+'.</div>';
  }
  if(p.shopify_article_id){
    // Published posts keep the button: refreshing the shop block re-runs the
    // congruence merchandiser on the LIVE article (an owner-set hero image is
    // never overwritten, and publish state is never touched).
    var lbl=p.status==='published'?'Refresh shop block':(related.length?'Refresh image + shop block':'Add image + shop block');
    h+='<div class="blg-actions"><button type="button" class="btn-sm" onclick="blogEnrich(\\''+esc(p.shopify_article_id)+'\\')">'+lbl+'</button></div>';
  }
  if(p.status!=='published'){
    h+='<div class="blg-meta">Review and publish in Shopify admin: Online Store &gt; Blog posts. You can swap the hero image there before publishing.</div>';
  }
  return h+'</div>';
}
async function loadContent(){
  var box=el('blg-list'); if(!box) return;
  try{
    var r=await api('/blog/list',{});
    if(!r.ok){ box.innerHTML='<p class="muted">Could not load drafts.</p>'; return; }
    if(!r.posts||!r.posts.length){ box.innerHTML='<p class="muted">No posts yet. Draft your first one above.</p>'; return; }
    var h=''; for(var i=0;i<r.posts.length;i++) h+=blgItemHtml(r.posts[i]);
    box.innerHTML=h;
  }catch(e){ box.innerHTML='<p class="muted">Could not load drafts.</p>'; }
  sydLoad();
}
async function blogGenerate(){
  var btn=el('blg-gen-btn');
  var topic=((el('blg-topic')&&el('blg-topic').value)||'').trim();
  // A chosen suggestion carries its full validated brief; otherwise send the
  // freehand topic (blank lets the agent choose).
  var payload = blgChosen ? {brief:blgChosen.brief} : {topicHint:topic};
  if(btn) btn.disabled=true;
  setMsg('blg-msg','Writing the post from your real products. This can take up to a minute.','muted');
  try{
    var r=await api('/blog/generate',payload);
    if(!r.ok){ setMsg('blg-msg','Could not create a post: '+esc(r.error||'unknown error'),'no'); }
    else{
      var extra=(r.claimFlags&&r.claimFlags.length)?(' '+r.claimFlags.length+' line(s) were flagged to verify before you publish.'):'';
      setMsg('blg-msg','Draft created: "'+esc(r.title)+'". Review and publish it in Shopify admin (Online Store, Blog posts).'+extra,'ok');
      if(el('blg-topic')) el('blg-topic').value='';
      blgChosen=null;
      var sel=el('blg-suggest'); if(sel){ sel.style.display='none'; sel.innerHTML=''; }
      loadContent();
    }
  }catch(e){ setMsg('blg-msg','Could not create a post: '+errText(e),'no'); }
  if(btn) btn.disabled=false;
}
async function blogEnrich(articleId){
  setMsg('blg-msg','Adding the shop block and a hero image. This reads the post and picks products it links.','muted');
  try{
    var r=await api('/blog/enrich',{articleId:articleId});
    if(!r.ok){ setMsg('blg-msg','Could not enrich the post: '+esc(r.error||'unknown error'),'no'); return; }
    var n=(r.relatedHandles&&r.relatedHandles.length)||0;
    var img;
    if(r.imageSet){
      img=' Hero image added'+(r.heroSourceHandle?(' from '+esc(r.heroSourceHandle)):'')+'.';
      if(!r.heroIsHighRes){ img+=' That source is under 1200px, so the social card will not be full size - upload a larger hero in admin for a crisp 1200x1200 preview.'; }
    }else{
      img=r.hadImage?' Your existing hero image was kept.':' No product image was available for a hero.';
    }
    setMsg('blg-msg','Shop block set: '+n+' product(s).'+img+' Review and publish in Shopify admin (you can swap the hero there).','ok');
    loadContent();
  }catch(e){ setMsg('blg-msg','Could not enrich the post: '+errText(e),'no'); }
}
// --- Distribution (syndication): creative packs + per-channel sends ---
var sydState=null;
function sydChip(st){
  var cls=st==='published'?'syd-pub':(st==='sent'?'syd-sent':(st==='failed'?'syd-fail':'syd-q'));
  return '<span class="syd-chip '+cls+'">'+esc(st)+'</span>';
}
function sydChannelBox(k,ch){
  var state=ch.accountId?((k==='pinterest'&&!ch.boardId)||(k==='facebook'&&!ch.pageId)?'account linked, pick a '+(k==='pinterest'?'board':'page'):'ready'):'not linked';
  var h='<div class="syd-ch-box"><strong>'+esc(k)+'</strong>'
    +'<label><input type="checkbox" '+(ch.enabled?'checked':'')+' onchange="sydSaveConfig(\\''+esc(k)+'\\',{enabled:this.checked})"> enabled</label>'
    +'<label><input type="checkbox" '+(ch.auto?'checked':'')+' onchange="sydSaveConfig(\\''+esc(k)+'\\',{auto:this.checked})"> auto</label>'
    +'<span class="muted">'+esc(state)+'</span></div>';
  return h;
}
function sydRenderChannels(){
  var box=el('syd-channels'); if(!box||!sydState) return;
  var h='';
  var ks=['pinterest','facebook','instagram'];
  for(var i=0;i<ks.length;i++) h+=sydChannelBox(ks[i],sydState.syndicate.channels[ks[i]]||{});
  if(!sydState.blotatoConfigured) h+='<div class="syd-ch-box syd-fail" style="border-color:rgba(248,81,73,.4)">Blotato key not set - queued items wait until the BLOTATO_API_KEY secret exists.</div>';
  box.innerHTML=h;
}
function sydPostHtml(p){
  var pack=(sydState.packs&&sydState.packs[p.id])||null;
  var rows=[]; var lg=sydState.ledger||[];
  for(var i=0;i<lg.length;i++) if(lg[i].post_id===p.id) rows.push(lg[i]);
  var h='<div class="blg-item"><div class="blg-item-head"><span class="blg-item-title">'+esc(p.title)+'</span></div>';
  if(pack&&pack.captions){ h+='<div class="syd-cap"><strong>Pin:</strong> '+esc(pack.captions.pinTitle||'')+' - '+esc(pack.captions.pinDesc||'')+'</div>'
    +'<div class="syd-cap"><strong>Caption:</strong> '+esc(pack.captions.caption||'')+'</div>'; }
  else h+='<div class="syd-cap muted">No creative pack yet - it builds on the next sweep, or click a Send button to build it now.</div>';
  h+='<div class="syd-row">';
  for(var j=0;j<rows.length;j++){
    var r=rows[j];
    h+='<span>'+esc(r.channel)+' '+sydChip(r.status);
    if(r.status!=='published'&&r.status!=='sent') h+=' <button type="button" class="btn-sm" data-syd-send="'+esc(p.id)+'|'+esc(r.channel)+'">'+(r.status==='failed'?'Retry':'Send')+'</button>';
    h+='</span>';
    if(r.error) h+='<span class="syd-cap syd-fail" style="background:transparent">'+esc(r.error)+'</span>';
  }
  if(!rows.length) h+='<span class="muted" style="font-size:12px">No channels enabled yet - enable one above.</span>';
  h+=' <button type="button" class="btn-sm" data-syd-regen="'+esc(p.id)+'">Regenerate pack</button>';
  return h+'</div></div>';
}
async function sydLoad(){
  var box=el('syd-list'); if(!box) return;
  try{
    var r=await api('/syndicate/list',{});
    if(!r.ok){ box.innerHTML='<p class="muted">Could not load distribution state.</p>'; return; }
    sydState=r;
    sydRenderChannels();
    if(!r.posts||!r.posts.length){ box.innerHTML='<p class="muted">No published guides yet. Publish one and it appears here within 15 minutes.</p>'; return; }
    var h=''; for(var i=0;i<r.posts.length;i++) h+=sydPostHtml(r.posts[i]);
    box.innerHTML=h;
  }catch(e){ box.innerHTML='<p class="muted">Could not load distribution state.</p>'; }
}
async function sydSaveConfig(k,patch){
  var channels={}; channels[k]=patch;
  try{
    var r=await api('/syndicate/config',{channels:channels});
    if(!r.ok){ setMsg('syd-msg','Could not save: '+esc(r.error||'unknown'),'no'); return; }
    if(sydState) sydState.syndicate=r.syndicate;
    sydRenderChannels();
    setMsg('syd-msg','Saved.','ok');
  }catch(e){ setMsg('syd-msg','Could not save: '+errText(e),'no'); }
}
async function sydAccounts(btn){
  if(btn) btn.disabled=true;
  setMsg('syd-msg','Reading your Blotato connections…','muted');
  try{
    var r=await api('/syndicate/accounts',{});
    if(!r.ok){ setMsg('syd-msg',esc(r.error||'Could not list accounts'),'no'); if(btn) btn.disabled=false; return; }
    var lines=[];
    for(var i=0;i<r.accounts.length;i++){
      var a=r.accounts[i]; var plat=(a.platform||'').toLowerCase();
      var name=a.username||a.name||a.id;
      if(plat==='pinterest'){
        var bs=(r.boards&&r.boards[a.id])||[];
        for(var j=0;j<bs.length;j++) lines.push('<button type="button" class="btn-sm" data-syd-wire="pinterest" data-syd-account="'+esc(a.id)+'" data-syd-board="'+esc(bs[j].id)+'">Pinterest: '+esc(name)+' / '+esc(bs[j].name||bs[j].id)+'</button>');
        if(!bs.length) lines.push('<span class="muted">Pinterest '+esc(name)+': no boards visible yet (new accounts can take 2-3 weeks to warm up; you can also paste the board id from Pinterest itself).</span>');
      }else if(plat==='facebook'){
        var ps=(r.pages&&r.pages[a.id])||[];
        for(var q=0;q<ps.length;q++) lines.push('<button type="button" class="btn-sm" data-syd-wire="facebook" data-syd-account="'+esc(a.id)+'" data-syd-page="'+esc(ps[q].id)+'">Facebook: '+esc(ps[q].name||ps[q].id)+'</button>');
      }else if(plat==='instagram'){
        lines.push('<button type="button" class="btn-sm" data-syd-wire="instagram" data-syd-account="'+esc(a.id)+'">Instagram: '+esc(name)+'</button>');
      }
    }
    var msgBox=el('syd-msg'); // setMsg() writes textContent (plain status text); this message
    // carries real <button> markup (the account/board picker) so it is written via innerHTML
    // directly, same as every other syd* list render. Dynamic parts above are already esc()'d.
    if(msgBox){
      msgBox.innerHTML=lines.length?('Pick to wire a channel: '+lines.join(' ')):'No connected accounts found - connect them in the Blotato dashboard first.';
      msgBox.className='msg ok';
    }
  }catch(e){ setMsg('syd-msg','Could not list accounts: '+errText(e),'no'); }
  if(btn) btn.disabled=false;
}
async function sydSend(btn,postId,channel){
  if(!prtArm(btn,'Posts publicly - click again to confirm')) return;
  setMsg('syd-msg','Sending to '+esc(channel)+'…','muted');
  try{
    var r=await api('/syndicate/send',{postId:postId,channel:channel});
    if(!r.ok){ setMsg('syd-msg','Send failed: '+esc(r.error||'unknown'),'no'); }
    else setMsg('syd-msg','Accepted - it confirms as published on the next sweep.','ok');
    sydLoad();
  }catch(e){ setMsg('syd-msg','Send failed: '+errText(e),'no'); }
}
async function sydRegen(btn,postId){
  if(btn) btn.disabled=true;
  setMsg('syd-msg','Rebuilding the creative pack…','muted');
  try{
    var r=await api('/syndicate/regenerate',{postId:postId});
    setMsg('syd-msg',r.ok?'Pack rebuilt.':('Could not rebuild: '+esc(r.error||'unknown')),r.ok?'ok':'no');
    sydLoad();
  }catch(e){ setMsg('syd-msg','Could not rebuild: '+errText(e),'no'); }
  if(btn) btn.disabled=false;
}
(function(){
  // Scoped to the Content view container (all views coexist in the DOM; a
  // document-level listener would run on every click console-wide and could
  // catch a stray data-syd-* attribute from another view).
  var scope=el('view-content'); if(!scope) return;
  scope.addEventListener('click',function(ev){
    var t=ev.target;
    if(!t||!t.getAttribute) return;
    var wire=t.getAttribute('data-syd-wire');
    if(wire){ var patch={accountId:t.getAttribute('data-syd-account')}; var b=t.getAttribute('data-syd-board'); if(b) patch.boardId=b; var pg=t.getAttribute('data-syd-page'); if(pg) patch.pageId=pg; sydSaveConfig(wire,patch); return; }
    var send=t.getAttribute('data-syd-send');
    if(send){ var parts=send.split('|'); sydSend(t,parts[0],parts[1]); return; }
    var regen=t.getAttribute('data-syd-regen');
    if(regen) sydRegen(t,regen);
  });
})();
`;
