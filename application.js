/* =========================================================================
   JangAfrika — Student Application Form · frontend logic
   Talks to the Apps Script Web App in Code.js.
   ========================================================================= */

// PASTE your deployed Apps Script Web App URL here (ends in /exec)
const API_URL = 'https://script.google.com/macros/s/AKfycbxw0bPC0sqWF7A0mfSLDhuWMDrB5WeqHlvY4q6M-9IkPrjLMFrYgIG_7MUJpZv7-tni/exec';

(function () {
  'use strict';

  const STEP_NAMES = ['Student information', 'Classes and subjects', 'Payment', 'Documents', 'Terms and consent'];
  const TOTAL_STEPS = STEP_NAMES.length;

  let CFG = null;          // form options loaded from the backend
  let currentStep = 1;
  let files = [];          // prepared report-card files: { name, size, data }
  let submitting = false;
  let dirty = false;
  let submitted = false;
  const submissionKey = makeKey(); // lets the server ignore an accidental double send

  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function makeKey() {
    return (window.crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : 'k-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }
  function todayIso() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function formatBytes(n) {
    return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
  }

  /* ---------------------------------------------------------------- API */

  /** POST as text/plain so the browser sends a "simple" request (no CORS pre-flight,
   *  which Apps Script cannot answer). Network-level failures are retried with backoff. */
  async function api(action, params, retries) {
    if (retries === undefined) retries = 2;
    if (!API_URL || API_URL.indexOf('PASTE_') === 0) {
      throw new Error('This form is not connected yet. Set API_URL at the top of application.js.');
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 120000);
    let res;
    try {
      res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({ action: action }, params || {})),
        signal: ctrl.signal
      });
    } catch (netErr) {
      clearTimeout(timer);
      if (retries > 0) {
        await sleep(800 * (3 - retries));
        return api(action, params, retries - 1);
      }
      throw new Error('Could not reach the server. Check your internet connection and try again.');
    }
    clearTimeout(timer);
    let json;
    try { json = await res.json(); } catch (e) { throw new Error('The server sent an unexpected reply. Please try again.'); }
    if (!json.success) throw new Error(json.error || 'Request failed.');
    return json.data;
  }

  /* --------------------------------------------------------- Load config */

  async function loadConfig() {
    const btn = $('startBtn');
    const status = $('introStatus');
    btn.disabled = true;
    status.textContent = 'Loading the form…';
    try {
      CFG = await api('getConfig');
      renderConfig();
      status.textContent = '';
      btn.disabled = false;
    } catch (err) {
      status.textContent = '';
      const msg = document.createElement('span');
      msg.style.color = '#b3261e';
      msg.textContent = err.message + ' ';
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'secondary';
      retry.textContent = 'Try again';
      retry.addEventListener('click', loadConfig);
      status.appendChild(msg);
      status.appendChild(retry);
    }
  }

  function choiceEl(type, name, value, title, detail) {
    const label = document.createElement('label');
    label.className = 'choice';
    const input = document.createElement('input');
    input.type = type; input.name = name; input.value = value;
    const body = document.createElement('span');
    const t = document.createElement('span');
    t.className = 'choice-title'; t.textContent = title;
    body.appendChild(t);
    if (detail) {
      const d = document.createElement('span');
      d.className = 'choice-detail'; d.textContent = detail;
      body.appendChild(d);
    }
    label.appendChild(input); label.appendChild(body);
    return label;
  }

  function renderConfig() {
    document.querySelectorAll('[data-cfg]').forEach((el) => { el.textContent = CFG[el.dataset.cfg]; });
    $('maxFilesText').textContent = CFG.maxFiles;
    $('maxMbText').textContent = CFG.maxFileMB;

    const groups = $('classGroups');
    groups.innerHTML = '';
    CFG.classGroups.forEach((g) => {
      const title = document.createElement('div');
      title.className = 'group-title'; title.textContent = g.title;
      const grid = document.createElement('div');
      grid.className = 'choice-grid';
      g.slots.forEach((s) => {
        const el = choiceEl('checkbox', 'classes', s, s);
        el.querySelector('input').dataset.day = dayOf(s);
        const tag = document.createElement('span');
        tag.className = 'choice-tag';
        tag.textContent = 'You already chose a class on this day';
        el.querySelector('span').appendChild(tag);
        grid.appendChild(el);
      });
      groups.appendChild(title); groups.appendChild(grid);
    });

    const subj = $('subjectList');
    subj.innerHTML = '';
    CFG.subjects.forEach((s) => subj.appendChild(choiceEl('checkbox', 'subjects', s, s)));

    const plans = $('planList');
    plans.innerHTML = '';
    CFG.paymentPlans.forEach((p) => plans.appendChild(choiceEl('radio', 'plan', p.value, p.value, p.detail)));

    const methods = $('methodList');
    methods.innerHTML = '';
    CFG.paymentMethods.forEach((m) => methods.appendChild(choiceEl('radio', 'method', m, m)));

    const terms = $('termsList');
    terms.innerHTML = '';
    CFG.terms.forEach((t, i) => terms.appendChild(choiceEl('checkbox', 'terms', String(i), t)));

    updateLimits();
    syncChoiceStyles();
  }

  /* ------------------------------------------------------ Choice tiles */

  const checkedValues = (name) => Array.from(document.querySelectorAll('input[name="' + name + '"]:checked')).map((i) => i.value);

  const dayOf = (slot) => String(slot).split(':')[0].trim();

  function limitGroup(name, max, counterId) {
    const boxes = document.querySelectorAll('input[name="' + name + '"]');
    const picked = checkedValues(name);
    const n = picked.length;
    const daysTaken = name === 'classes' ? picked.map(dayOf) : [];   // one class per day
    boxes.forEach((b) => {
      const sameDay = name === 'classes' && !b.checked && daysTaken.indexOf(b.dataset.day) !== -1;
      b.disabled = !b.checked && (n >= max || sameDay);
      const tile = b.closest('.choice');
      if (tile) tile.classList.toggle('day-blocked', sameDay);
    });
    $(counterId).textContent = n + ' of ' + max + ' selected';
  }
  function updateLimits() {
    if (!CFG) return;
    limitGroup('classes', CFG.maxClasses, 'classCounter');
    limitGroup('subjects', CFG.maxSubjects, 'subjectCounter');
  }
  function syncChoiceStyles() {
    document.querySelectorAll('.choice').forEach((c) => {
      const input = c.querySelector('input');
      c.classList.toggle('selected', input.checked);
      c.classList.toggle('disabled', input.disabled);
    });
  }


  /* ------------------------------------------------------- Voice guide */
  // Uses the browser's built-in text-to-speech. No audio files, no data cost.

  const TTS = ('speechSynthesis' in window && 'SpeechSynthesisUtterance' in window) ? window.speechSynthesis : null;
  let voiceOn = true;
  try { voiceOn = localStorage.getItem('ja_voice') !== 'off'; } catch (e) { /* storage blocked: keep default */ }
  let speakingKey = null;
  let speakToken = 0;

  function guideText(key) {
    const c = CFG || {};
    const plans = (c.paymentPlans || []).map((p) => p.value + ': ' + p.detail).join('. Or, ');
    const guides = {
      intro: 'Welcome to the JangAfrika Study Centre application form. Classes start on ' + c.startDate + '. ' +
        'The form has 5 short steps. Before you start, please have your child\'s report card ready, as a photo or a PDF, and a phone number for the parent or guardian. An email address is optional. ' +
        'When you are ready, press the green button, Start application.',
      1: 'Step 1 of 5. Student information. Type your child\'s full name. Choose the date of birth. ' +
        'Write the grade, for example Grade 6, and the name of the school your child attends now. ' +
        'Then type the name and telephone number of a person we can call in an emergency, and write your home address. ' +
        'All these boxes are needed. When you finish, press Next.',
      2: 'Step 2 of 5. Classes and subjects. Choose up to ' + c.maxClasses + ' classes. ' +
        'You can choose only one class on each day. When you pick a day, the other times on that day switch off. ' +
        'Then choose up to ' + c.maxSubjects + ' subjects. Students must come with a pen or pencil, exercise books, and textbooks if available. ' +
        'When you finish, press Next.',
      3: 'Step 3 of 5. Payment. First, choose a payment plan. ' + plans + '. ' +
        'Next, choose the date you would like to start paying. Then choose how you will pay. ' +
        'When you finish, press Next.',
      4: 'Step 4 of 5. Documents. Your child\'s report card must be sent with this form. ' +
        'Press the button, Choose report card file, then take a clear photo or pick a PDF. ' +
        'If the report card has many pages, you can add up to ' + c.maxFiles + ' files. ' +
        'When the file is on the list, press Next.',
      5: 'Step 5 of 5. Terms and consent. Read each term, and tick every box to show that you agree. ' +
        'Then type the parent or guardian\'s full name and phone number. The email address is optional. ' +
        'To sign, type your first name and last name in the signature box. ' +
        'When you finish, press Submit application.',
      success: 'Your application has been received. Please keep your reference number. ' +
        'It is ' + String($('refNumber').textContent || '').split('-').map((p) => p.split('').join(' ')).join(', ') + '. ' +
        'The Study centre office will review the application and the report card. Thank you.'
    };
    return guides[key] || '';
  }

  function pickVoice() {
    const vs = TTS.getVoices();
    return vs.find((v) => /^en[-_](GB|GM|NG|GH|ZA|KE)/i.test(v.lang)) || vs.find((v) => /^en/i.test(v.lang)) || null;
  }

  function refreshVoiceUi() {
    document.querySelectorAll('.listen').forEach((b) => {
      const on = String(speakingKey) === b.dataset.guide;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.querySelector('.lt').textContent = on ? 'Stop' : 'Listen';
    });
    const t = $('voiceToggle');
    if (t) { t.setAttribute('aria-pressed', voiceOn ? 'true' : 'false'); $('voiceState').textContent = voiceOn ? 'On' : 'Off'; }
  }

  function stopSpeech() {
    if (!TTS) return;
    speakToken++;
    TTS.cancel();
    speakingKey = null;
    refreshVoiceUi();
  }

  function speak(key) {
    if (!TTS) return;
    TTS.cancel();
    const token = ++speakToken;
    const text = guideText(key);
    const chunks = text.match(/[^.!?]+[.!?]*/g) || [text];   // short pieces: long speech gets cut off on some phones
    const voice = pickVoice();
    speakingKey = key;
    refreshVoiceUi();
    chunks.forEach((piece, i) => {
      const u = new SpeechSynthesisUtterance(piece.trim());
      u.lang = voice ? voice.lang : 'en-GB';
      if (voice) u.voice = voice;
      u.rate = 0.92;
      if (i === chunks.length - 1) {
        const done = () => { if (token === speakToken) { speakingKey = null; refreshVoiceUi(); } };
        u.onend = done; u.onerror = done;
      }
      TTS.speak(u);
    });
  }

  /** Called whenever a new section appears. Speaks it if the voice guide is on. */
  function autoSpeak(key) {
    if (!TTS) return;
    if (voiceOn) speak(key); else stopSpeech();
  }

  function currentKey() {
    if (!$('screenIntro').classList.contains('hidden')) return 'intro';
    if (!$('screenSuccess').classList.contains('hidden')) return 'success';
    return currentStep;
  }

  function initVoice() {
    if (!TTS) return;                         // browser has no speech: hide everything voice-related
    const makeBtn = (key, host) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'listen secondary'; b.dataset.guide = String(key);
      b.setAttribute('aria-label', 'Listen to the instructions for this section');
      b.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4z"/></svg><span class="lt">Listen</span>';
      b.addEventListener('click', () => { if (String(speakingKey) === String(key)) stopSpeech(); else speak(key); });
      host.insertBefore(b, host.firstChild);
    };
    makeBtn('intro', document.querySelector('.intro-head'));
    document.querySelectorAll('.step').forEach((s) => makeBtn(s.dataset.step, s));
    makeBtn('success', $('screenSuccess'));

    $('voiceToggle').classList.remove('hidden');
    $('voiceToggle').addEventListener('click', () => {
      voiceOn = !voiceOn;
      try { localStorage.setItem('ja_voice', voiceOn ? 'on' : 'off'); } catch (e) { /* ignore */ }
      if (voiceOn) speak(currentKey()); else stopSpeech();
    });
    if (TTS.onvoiceschanged !== undefined) TTS.onvoiceschanged = () => {};   // voices load late on some browsers
    window.addEventListener('pagehide', () => TTS.cancel());
    refreshVoiceUi();
  }

  /* ------------------------------------------------------ Step control */

  function showStep(n) {
    currentStep = n;
    document.querySelectorAll('.step').forEach((s) => s.classList.toggle('hidden', Number(s.dataset.step) !== n));
    $('stepLabel').textContent = 'Step ' + n + ' of ' + TOTAL_STEPS;
    $('stepName').textContent = STEP_NAMES[n - 1];
    document.querySelectorAll('#stepper li').forEach((li) => {
      const i = Number(li.dataset.s);
      li.classList.toggle('done', i < n);
      li.classList.toggle('current', i === n);
      li.querySelector('.dot').textContent = i < n ? '✓' : String(i);
    });
    const last = n === TOTAL_STEPS;
    $('nextBtn').classList.toggle('hidden', last);
    $('submitBtn').classList.toggle('hidden', !last);
    $('formError').classList.add('hidden');
    if (last) updateConsentText();
    autoSpeak(n);
    const heading = $('h' + n);
    window.scrollTo({ top: 0 });
    if (heading) heading.focus({ preventScroll: true });
  }

  function showIntro() {
    stopSpeech();
    $('appForm').classList.add('hidden');
    $('screenIntro').classList.remove('hidden');
    window.scrollTo({ top: 0 });
  }

  /* -------------------------------------------------------- Validation */

  function setErr(id, msg) {
    const el = $('err-' + id);
    if (el) el.textContent = msg || '';
    const input = $(id);
    if (input && /^(INPUT|TEXTAREA|SELECT)$/.test(input.tagName)) {
      if (msg) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
    }
  }
  function clearErrors(step) {
    const sec = document.querySelector('.step[data-step="' + step + '"]');
    sec.querySelectorAll('.field-error').forEach((e) => { e.textContent = ''; });
    sec.querySelectorAll('[aria-invalid]').forEach((e) => e.removeAttribute('aria-invalid'));
  }
  function focusFirst(id) {
    const el = $(id);
    if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) el.focus();
    else { const e = $('err-' + id); if (e) e.scrollIntoView({ block: 'center' }); }
  }
  const digits = (s) => s.replace(/\D/g, '').length;
  const validSignature = (s) => s.split(/\s+/).filter((w) => w.length > 1).length >= 2;
  const validPhone = (s) => /^[+()\d\s\-\/]{6,25}$/.test(s) && digits(s) >= 6;

  /** Returns true when the step is valid; otherwise shows errors and focuses the first bad field. */
  function validateStep(n) {
    clearErrors(n);
    const bad = [];
    const fail = (id, msg) => { setErr(id, msg); bad.push(id); };
    const val = (id) => $(id).value.trim();

    if (n === 1) {
      if (val('fullName').length < 3) fail('fullName', "Enter the student's full name.");
      const dob = val('dob');
      const oldest = (new Date().getFullYear() - 30) + todayIso().slice(4);
      if (!dob) fail('dob', 'Enter the date of birth.');
      else if (dob >= todayIso()) fail('dob', 'The date of birth must be in the past.');
      else if (dob < oldest) fail('dob', 'Check the date of birth. It looks too long ago.');
      if (!val('grade')) fail('grade', 'Enter the grade.');
      if (!val('currentSchool')) fail('currentSchool', 'Enter the current school.');
      if (!val('emergencyName')) fail('emergencyName', 'Enter the emergency contact name.');
      if (!validPhone(val('emergencyPhone'))) fail('emergencyPhone', 'Enter a valid telephone number.');
      if (!val('address')) fail('address', 'Enter the address.');
    }
    if (n === 2) {
      const c = checkedValues('classes').length;
      const days = checkedValues('classes').map(dayOf);
      if (c < 1) fail('classes', 'Select at least one class.');
      else if (days.some((d, i) => days.indexOf(d) !== i)) fail('classes', 'You can only choose one class per day.');
      const s = checkedValues('subjects').length;
      if (s < 1) fail('subjects', 'Select at least one subject.');
    }
    if (n === 3) {
      if (!checkedValues('plan').length) fail('plan', 'Select a payment option.');
      const ps = val('paymentStart');
      if (!ps) fail('paymentStart', 'Enter your preferred payment start date.');
      else if (ps < todayIso()) fail('paymentStart', 'The date must be today or later.');
      if (!checkedValues('method').length) fail('method', 'Select a mode of payment.');
    }
    if (n === 4) {
      if (CFG.requireReportCard && !files.length) fail('files', "Upload your child's report card to continue.");
    }
    if (n === 5) {
      if (checkedValues('terms').length !== CFG.terms.length) fail('terms', 'Tick every box to agree to the terms and conditions.');
      if (val('parentName').length < 3) fail('parentName', 'Write your full name.');
      if (!validPhone(val('parentPhone'))) fail('parentPhone', 'Enter a valid phone number.');
      if (val('parentEmail') && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(val('parentEmail'))) fail('parentEmail', 'Enter a valid email address, or leave it empty.');
      if (!validSignature(val('signature'))) fail('signature', 'Type your first and last name to sign.');
    }
    if (bad.length) { focusFirst(bad[0]); return false; }
    return true;
  }

  /* ------------------------------------------------------ Report card */

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('unreadable')); };
      img.src = url;
    });
  }
  /** Shrinks a phone photo (often 4–8 MB) to a sharp ~0.5 MB JPEG so uploads are fast on mobile data. */
  async function compressImage(file) {
    const img = await loadImage(file);
    const scale = Math.min(1, 1800 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82));
  }
  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1]);
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  }
  async function prepareFile(file) {
    const maxBytes = CFG.maxFileMB * 1024 * 1024;
    const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
    if (isPdf) {
      if (file.size > maxBytes) throw new Error(file.name + ' is larger than ' + CFG.maxFileMB + ' MB. Use a smaller PDF, or upload photos of the pages instead.');
      return { name: file.name, size: file.size, data: await blobToBase64(file) };
    }
    if (/^image\//.test(file.type)) {
      let blob = null;
      try { blob = await compressImage(file); } catch (e) { blob = null; }
      let name = file.name.replace(/\.[^.]+$/, '') + '.jpg';
      if (!blob) {
        if (/^image\/(jpeg|png|webp)$/.test(file.type) && file.size <= maxBytes) { blob = file; name = file.name; }
        else throw new Error(file.name + ' could not be read. Use a JPG or PNG photo, or a PDF.');
      }
      if (blob.size > maxBytes) throw new Error(file.name + ' is still larger than ' + CFG.maxFileMB + ' MB. Try a smaller photo.');
      return { name: name, size: blob.size, data: await blobToBase64(blob) };
    }
    throw new Error(file.name + ' is not a photo or a PDF.');
  }

  function renderFiles() {
    const list = $('fileList');
    list.innerHTML = '';
    files.forEach((f, i) => {
      const li = document.createElement('li');
      const left = document.createElement('span');
      left.className = 'file-name'; left.textContent = f.name;
      const size = document.createElement('span');
      size.className = 'file-size'; size.textContent = formatBytes(f.size);
      left.appendChild(size);
      const rm = document.createElement('button');
      rm.type = 'button'; rm.className = 'link'; rm.textContent = 'Remove';
      rm.setAttribute('aria-label', 'Remove ' + f.name);
      rm.addEventListener('click', () => { files.splice(i, 1); renderFiles(); dirty = true; });
      li.appendChild(left); li.appendChild(rm);
      list.appendChild(li);
    });
    $('pickFileBtn').textContent = files.length ? 'Add another file' : 'Choose report card file';
    $('pickFileBtn').disabled = files.length >= CFG.maxFiles;
  }

  async function onFilesPicked(e) {
    const picked = Array.from(e.target.files);
    e.target.value = '';
    if (!picked.length) return;
    setErr('files', '');
    const room = Math.max(CFG.maxFiles - files.length, 0);
    const use = picked.slice(0, room);
    const problems = [];
    if (picked.length > room) problems.push('You can upload up to ' + CFG.maxFiles + ' files.');
    $('fileStatus').textContent = 'Preparing…';
    for (const f of use) {
      try { files.push(await prepareFile(f)); dirty = true; }
      catch (err) { problems.push(err.message); }
    }
    $('fileStatus').textContent = '';
    renderFiles();
    if (problems.length) setErr('files', problems.join(' '));
  }

  /* -------------------------------------------------------- Signature */

  function updateConsentText() {
    const blank = '………………………';
    $('consentParent').textContent = $('parentName').value.trim() || blank;
    $('consentChild').textContent = $('fullName').value.trim() || blank;
    $('consentDate').textContent = new Date().toLocaleDateString('en-GB');
    $('sigPreview').textContent = $('signature').value.trim();
  }

  /* ------------------------------------------------------------ Submit */

  async function submit() {
    if (submitting) return;
    for (let s = 1; s <= TOTAL_STEPS; s++) {           // re-check everything, jump to the first problem
      if (!validateStep(s)) {
        if (currentStep !== s) { showStep(s); validateStep(s); }
        return;
      }
    }
    submitting = true;
    stopSpeech();
    $('submitBtn').disabled = true;
    $('formError').classList.add('hidden');
    $('busy').classList.remove('hidden');
    const v = (id) => $(id).value.trim();
    try {
      const result = await api('submitApplication', {
        submissionKey: submissionKey,
        data: {
          studentName: v('fullName'), dob: v('dob'), grade: v('grade'), currentSchool: v('currentSchool'),
          emergencyName: v('emergencyName'), emergencyPhone: v('emergencyPhone'), address: v('address'),
          classes: checkedValues('classes'), subjects: checkedValues('subjects'),
          paymentPlan: checkedValues('plan')[0], paymentStart: v('paymentStart'), paymentMethod: checkedValues('method')[0],
          termsAccepted: CFG.terms.map((_, i) => !!document.querySelector('input[name="terms"][value="' + i + '"]:checked')),
          parentName: v('parentName'), parentPhone: v('parentPhone'), parentEmail: v('parentEmail'),
          website: $('hpField').value
        },
        files: files.map((f) => ({ name: f.name, data: f.data })),
        signature: v('signature')
      });
      submitted = true;
      $('successName').textContent = v('fullName');
      $('refNumber').textContent = result.applicationId;
      $('appForm').classList.add('hidden');
      $('screenSuccess').classList.remove('hidden');
      window.scrollTo({ top: 0 });
      $('successTitle').focus({ preventScroll: true });
      autoSpeak('success');
    } catch (err) {
      const box = $('formError');
      box.textContent = err.message;
      box.classList.remove('hidden');
      box.scrollIntoView({ block: 'center' });
    } finally {
      submitting = false;
      $('submitBtn').disabled = false;
      $('busy').classList.add('hidden');
    }
  }

  /* -------------------------------------------------------------- Wire */

  function init() {
    $('dob').max = todayIso();
    $('paymentStart').min = todayIso();

    $('startBtn').addEventListener('click', () => {
      $('screenIntro').classList.add('hidden');
      $('appForm').classList.remove('hidden');
      showStep(1);
    });
    $('backBtn').addEventListener('click', () => { if (currentStep === 1) showIntro(); else showStep(currentStep - 1); });
    $('pickFileBtn').addEventListener('click', () => $('reportFile').click());
    $('reportFile').addEventListener('change', onFilesPicked);
    $('anotherBtn').addEventListener('click', () => location.reload());

    // Enter key / Next / Submit all arrive here.
    $('appForm').addEventListener('submit', (e) => {
      e.preventDefault();
      if (currentStep < TOTAL_STEPS) { if (validateStep(currentStep)) showStep(currentStep + 1); }
      else submit();
    });

    $('appForm').addEventListener('change', () => { updateLimits(); syncChoiceStyles(); });
    $('appForm').addEventListener('input', (e) => {
      dirty = true;
      if (e.target.id && $('err-' + e.target.id)) setErr(e.target.id, '');
      if (['parentName', 'fullName', 'signature'].indexOf(e.target.id) !== -1) updateConsentText();
    });
    ['classes', 'subjects', 'plan', 'method', 'terms'].forEach((g) => {
      document.addEventListener('change', (e) => { if (e.target.name === g) setErr(g, ''); });
    });

    window.addEventListener('beforeunload', (e) => {
      if (dirty && !submitted) { e.preventDefault(); e.returnValue = ''; }
    });

    initVoice();
    loadConfig();
  }

  init();
})();
