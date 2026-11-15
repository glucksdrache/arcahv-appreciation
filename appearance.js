(() => {
  'use strict';

  const root = document.documentElement;
  const picker = document.getElementById('scene-file');
  const choose = document.getElementById('import-scene');
  const reset = document.getElementById('reset-scene');
  const status = document.getElementById('scene-status');
  let currentUrl;
  let statusLabel;
  const lang = window.studyLanguage || {text: en => en, error: (e,en) => e?.message || en};
  function renderStatus() {
    if (status && statusLabel) status.textContent = ' ' + statusLabel();
  }
  function sceneError(err) {
    statusLabel = () => lang.error(err, 'Choose an image and try again.', '请选择一张图片，再试一次。');
    renderStatus();
  }
  window.addEventListener('study-language-change', renderStatus);

  async function localOverride(file) {
    // Older versions saved the original VS-8 image as a local background.
    if (file?.size !== 583876 || !globalThis.crypto?.subtle) return file;
    const hash = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    const hex = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
    return hex === '44de9ce29772b4c60b38ffcb244230a6cfcfd625efd3cc049a6b8b41fa71575d' ? null : file;
  }

  function show(file) {
    const url = file ? URL.createObjectURL(file) : null;
    if (url) {
      root.style.setProperty('--scene', 'url("' + url + '")');
      root.style.setProperty('--scene-portrait', 'var(--scene)');
    } else {
      root.style.removeProperty('--scene');
      root.style.removeProperty('--scene-portrait');
    }
    if (currentUrl) URL.revokeObjectURL(currentUrl);
    currentUrl = url;
    if (reset) reset.hidden = !url;
  }

  async function change(file) {
    choose.disabled = reset.disabled = true;
    try {
      const override = await localOverride(file);
      const result = await studyMedia.setScene(override);
      show(override);
      statusLabel = () => override
        ? (result.persistent ? lang.text('Local scene saved in this browser.', '背景已保存到此浏览器。')
          : lang.text('Local scene applied for this visit.', '本次浏览已换用所选背景。'))
        : lang.text('VS-8 background restored.', '已恢复 VS-8 背景。');
      renderStatus();
    } catch (err) {
      sceneError(err);
    } finally {
      choose.disabled = reset.disabled = false;
    }
  }

  async function init() {
    if (choose) choose.disabled = true;
    try {
      show(await localOverride(await studyMedia.getScene()));
    } catch (err) {
      sceneError(err);
    } finally {
      if (choose) choose.disabled = false;
    }
    choose?.addEventListener('click', () => picker.click());
    reset?.addEventListener('click', () => change(null));
    picker?.addEventListener('change', () => {
      const file = picker.files[0];
      picker.value = '';
      if (file) change(file);
    });
  }

  init();
})();
