(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const esc = (s) => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const today = new Date();
  const dateText = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;

  async function api(url, options = {}) {
    const response = await fetch(url, {headers:{'Content-Type':'application/json'}, credentials:'same-origin', ...options});
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || '連線發生問題，請稍後再試。');
    return payload;
  }

  async function loadDashboard() {
    try {
      const data = await api('/api/dashboard');
      const card = $('#status-card');
      if (!card) return;
      card.className = `status-card status-${data.status}`;
      $('#status-title').textContent = data.status_info.label;
      $('#status-description').textContent = data.status_info.description;
      $('#status-date').textContent = new Intl.DateTimeFormat('zh-TW',{month:'2-digit',day:'2-digit'}).format(today);
      $('#header-status').innerHTML = `<i></i>${esc(data.status_info.label)}`;
      $('#price-value').textContent = Number(data.price).toLocaleString('zh-TW');
      $('#area-tags').innerHTML = data.areas.length ? data.areas.map(area => `<span class="tag">${esc(area)}</span>`).join('') : '<span class="tag tag-muted">今日暫無開放區域</span>';
      $('#updated-at').textContent = data.updated_at || '—';
    } catch (error) {
      const title = $('#status-title'); if (title) title.textContent = '果況暫時無法載入';
      const desc = $('#status-description'); if (desc) desc.textContent = '請稍後重新整理，或來電確認今日開放狀況。';
    }
  }

  const dateInput = $('#visit-date');
  if (dateInput) {
    dateInput.min = dateText(today);
    const maxDate = new Date(today); maxDate.setDate(maxDate.getDate()+14); dateInput.max = dateText(maxDate);
    dateInput.value = dateText(today);
    const slotWrap = $('#slot-options');
    async function loadSlots() {
      slotWrap.innerHTML = '<p class="form-hint">正在查詢剩餘名額…</p>';
      try {
        const data = await api(`/api/availability?date=${encodeURIComponent(dateInput.value)}`);
        slotWrap.innerHTML = data.slots.map(item => `<label class="slot-option ${item.remaining===0?'slot-full':''}"><input type="radio" name="slot" value="${esc(item.slot)}" ${item.remaining===0?'disabled':''}><span class="slot-time">${esc(item.slot)}</span><span class="slot-remaining">${item.remaining===0?'已額滿':`剩 ${item.remaining} 組`}</span></label>`).join('');
      } catch (error) { slotWrap.innerHTML = `<p class="form-hint form-error">${esc(error.message)}</p>`; }
    }
    dateInput.addEventListener('change', loadSlots); loadSlots();
    $('#booking-form').addEventListener('submit', async event => {
      event.preventDefault();
      const form = event.currentTarget, errorBox = $('#form-error'); errorBox.textContent = '';
      if (!form.reportValidity()) return;
      if (!/^09\d{8}$/.test(form.elements.phone.value.trim())) { errorBox.textContent = '請輸入 09 開頭的 10 碼手機號碼。'; form.elements.phone.focus(); return; }
      const body = {date:form.elements.date.value,slot:form.elements.slot?.value,name:form.elements.name.value.trim(),phone:form.elements.phone.value.trim(),people:form.elements.people.value,cars:form.elements.cars.value};
      if (!body.slot) { errorBox.textContent = '請先選擇尚有名額的梯次。'; return; }
      const submit = $('.submit-button', form); submit.disabled = true; submit.innerHTML = '送出中…';
      try {
        const result = await api('/api/bookings',{method:'POST',body:JSON.stringify(body)});
        $('#booking-form-wrap').hidden = true;
        const target = $('#booking-success'); target.hidden = false;
        const map = 'https://www.google.com/maps/search/?api=1&query='+encodeURIComponent('苗栗縣大湖鄉台三線旁示範農園');
        target.innerHTML = `<span class="success-flower">✿</span><p class="eyebrow">YOU'RE ALL SET</p><h3>預約完成，<br>等你來摘草莓。</h3><p>已為你保留入園時段，請在抵達時出示下方車位代碼。</p><div class="booking-pass"><span>專屬車位保留代碼</span><strong>${esc(result.code)}</strong><span>${esc(result.date)}・${esc(result.slot)} 梯次</span></div><a class="button" href="${map}" target="_blank" rel="noopener">Google 地圖導航 ↗</a><p class="pass-reminder">請截圖保存憑證，期待與你見面！</p><button class="reset-booking" type="button">再預約一個時段</button>`;
        $('.reset-booking',target).addEventListener('click',()=>{target.hidden=true;$('#booking-form-wrap').hidden=false;form.reset();dateInput.value=dateText(today);loadSlots();});
      } catch (error) { errorBox.textContent = error.message; await loadSlots(); }
      finally { submit.disabled = false; submit.innerHTML = '確認預約 <span>→</span>'; }
    });
  }
  loadDashboard();

  const pinForm = $('#pin-form');
  if (!pinForm) return;
  let selectedStatus = 'green';
  function setStatus(status) {
    selectedStatus = status;
    $$('.status-choice').forEach(button => button.classList.toggle('selected',button.dataset.status===status));
    const text = {green:'綠燈充沛',yellow:'黃燈受限',red:'紅燈休園'};
    $('#selected-status-note').textContent = `目前：${text[status]}`;
  }
  async function loadAdminData() {
    const dashboard = await api('/api/dashboard'); setStatus(dashboard.status);
    $('#admin-price').value = dashboard.price;
    $$('#admin-areas input').forEach(box => box.checked = dashboard.areas.includes(box.value));
    const data = await api('/api/admin/today');
    const formatted = new Intl.DateTimeFormat('zh-TW',{year:'numeric',month:'long',day:'numeric',weekday:'long'}).format(today);
    $('#today-date').textContent = formatted;
    $('#reservation-counts').innerHTML = Object.entries(data.counts).map(([slot,count])=>`<div class="reservation-count"><span>${esc(slot)}</span><b>${count}<small> / 15 組</small></b></div>`).join('');
    $('#today-bookings').innerHTML = data.bookings.length ? `<div class="booking-list-head"><span>梯次 / 姓名</span><span>聯絡電話</span><span>車位代碼</span><span>車輛</span></div>`+data.bookings.map(b=>`<div class="booking-list-row"><span><b>${esc(b.slot)}・${esc(b.name)}</b><small>${b.people} 位訪客</small></span><a href="tel:${esc(b.phone)}">${esc(b.phone)}</a><strong>${esc(b.code)}</strong><span>${b.cars} 輛</span></div>`).join(''):'<p class="empty-bookings">今天還沒有預約，期待第一位客人。</p>';
  }
  function showConsole() { $('#admin-login').hidden=true; $('#admin-console').hidden=false; }
  async function checkSession() { try { await loadAdminData(); showConsole(); } catch (_) {} }
  checkSession();
  pinForm.addEventListener('submit',async event=>{event.preventDefault();$('#pin-error').textContent='';try{await api('/api/admin/login',{method:'POST',body:JSON.stringify({pin:$('#pin-input').value})});await loadAdminData();showConsole();}catch(error){$('#pin-error').textContent=error.message;}});
  $$('.status-choice').forEach(button=>button.addEventListener('click',()=>setStatus(button.dataset.status)));
  $$('.price-presets button').forEach(button=>button.addEventListener('click',()=>{$('#admin-price').value=button.dataset.price;$$('.price-presets button').forEach(b=>b.classList.toggle('active',b===button));}));
  $('#save-dashboard').addEventListener('click',async event=>{const button=event.currentTarget,msg=$('#save-message');msg.textContent='';button.disabled=true;button.textContent='更新中…';try{const areas=$$('#admin-areas input:checked').map(box=>box.value);const result=await api('/api/admin/dashboard',{method:'POST',body:JSON.stringify({status:selectedStatus,price:$('#admin-price').value,areas})});msg.textContent=`✓ 已發布，更新時間 ${result.updated_at}`;msg.classList.add('saved');}catch(error){msg.textContent=error.message;msg.classList.remove('saved');if(error.message.includes('PIN')){ $('#admin-console').hidden=true;$('#admin-login').hidden=false; }}finally{button.disabled=false;button.innerHTML='發布今日更新 <span>→</span>';}});
  $('#admin-logout').addEventListener('click',async()=>{await api('/api/admin/logout',{method:'POST'});$('#admin-console').hidden=true;$('#admin-login').hidden=false;$('#pin-input').value='';});
})();
