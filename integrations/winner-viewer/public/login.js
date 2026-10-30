'use strict';

const form = document.getElementById('loginForm');
const username = document.getElementById('loginUsername');
const password = document.getElementById('loginPassword');
const submit = document.getElementById('loginSubmit');
const error = document.getElementById('loginError');

form.addEventListener('submit', async event => {
  event.preventDefault();
  error.textContent = '';
  submit.disabled = true;
  submit.textContent = '正在登录…';
  try {
    const response = await fetch('./api/login', {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: username.value.trim(),
        password: password.value,
      }),
    });
    const payload = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    password.value = '';
    window.location.reload();
  } catch (loginError) {
    error.textContent = loginError.message;
    password.focus();
  } finally {
    submit.disabled = false;
    submit.textContent = '登录并保持登录';
  }
});
