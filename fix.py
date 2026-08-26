import re

with open('resume_builder_1.html', 'r', encoding='utf-8') as f:
    html = f.read()

# We need to replace the corrupted block from 'if (data.sheets && data.sheets.length > 0)' inside refreshGate1Sheets 
# down to '} catch (e) { console.error('Error fetching sheets for gate 2:', e); }'

corrupted_pattern = re.compile(r'if \(data\.sheets && data\.sheets\.length > 0\) \{.*?\} catch \(e\) \{ console\.error\(''Error fetching sheets for gate 2:'', e\); \}', re.DOTALL)

fixed_code = '''if (data.sheets && data.sheets.length > 0) {
        data.sheets.forEach(s => {
          const opt = document.createElement('option');
          opt.value = s.key;
          opt.textContent = s.name + (s.is_default ? ' (Default)' : '');
          if (s.is_default) opt.selected = true;
          sel.appendChild(opt);
        });
      }
      
      if (data.has_legacy_fallback) {
        const opt = document.createElement('option');
        opt.value = 'legacy';
        opt.textContent = 'Legacy GOOGLE_SHEET_ID (Fallback)';
        if (!data.sheets || data.sheets.length === 0) opt.selected = true;
        sel.appendChild(opt);
      }
      onGate1SheetChange();
    }
  } catch (e) { console.error('Error fetching sheets for gate 1:', e); }
}

function onGate1SheetChange() {
  const sel = document.getElementById('gate1ActiveSheet');
  const btnSetDef = document.getElementById('btnSetDefaultSheet');
  const btnRem = document.getElementById('btnRemoveSheet');
  if (!sel || !sel.value) {
    if (btnSetDef) btnSetDef.style.display = 'none';
    if (btnRem) btnRem.style.display = 'none';
    return;
  }
  const isDefault = sel.options[sel.selectedIndex].text.includes('(Default)');
  if (btnSetDef) btnSetDef.style.display = isDefault ? 'none' : 'inline-block';
  if (btnRem) btnRem.style.display = 'inline-block';
}

async function setGate1DefaultSheet() {
  const sel = document.getElementById('gate1ActiveSheet');
  if (!sel || !sel.value) return;
  try {
    const res = await fetch(${GATE1_API}/sheets//default, { method: 'POST' });
    if (res.ok) {
      toast('Default sheet updated.', 'success');
      refreshGate1Sheets();
    } else {
      const data = await res.json();
      toast(data.detail || 'Error', 'error');
    }
  } catch(e) { toast(e.message, 'error'); }
}

async function removeGate1Sheet() {
  const sel = document.getElementById('gate1ActiveSheet');
  if (!sel || !sel.value) return;
  if (!confirm('Disconnect this sheet? (Does not delete it from Google Drive)')) return;
  try {
    const res = await fetch(${GATE1_API}/sheets/, { method: 'DELETE' });
    if (res.ok) {
      toast('Sheet disconnected.', 'success');
      refreshGate1Sheets();
    } else {
      const data = await res.json();
      toast(data.detail || 'Error', 'error');
    }
  } catch(e) { toast(e.message, 'error'); }
}

async function refreshGate2Sheets() {
  try {
    const res = await fetch(${GATE1_API}/sheets);
    const data = await res.json();
    if (res.ok) {
      const sel = document.getElementById('gate2TargetSheet');
      if (!sel) return;
      sel.innerHTML = '';
      if (data.sheets && data.sheets.length > 0) {
        data.sheets.forEach(s => {
          const opt = document.createElement('option');
          opt.value = s.key;
          opt.textContent = s.name + (s.is_default ? ' (Default)' : '');
          if (s.is_default) opt.selected = true;
          sel.appendChild(opt);
        });
      }
      if (data.has_legacy_fallback) {
        const opt = document.createElement('option');
        opt.value = 'legacy';
        opt.textContent = 'Legacy GOOGLE_SHEET_ID (Fallback)';
        if (!data.sheets || data.sheets.length === 0) opt.selected = true;
        sel.appendChild(opt);
      }
    }
  } catch (e) { console.error('Error fetching sheets for gate 2:', e); }'''

html = corrupted_pattern.sub(fixed_code, html)
with open('resume_builder_1.html', 'w', encoding='utf-8') as f:
    f.write(html)
print("Done!")
