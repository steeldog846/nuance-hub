// Fills in the contact address on the privacy and terms pages (set NUANCE_CONTACT_EMAIL on the server).
fetch('/api/config').then((r) => r.json()).then(({ contactEmail }) => {
  for (const el of document.querySelectorAll('.contact')) {
    if (contactEmail) {
      const a = document.createElement('a');
      a.href = `mailto:${contactEmail}`;
      a.textContent = contactEmail;
      el.replaceChildren(a);
    }
  }
}).catch(() => {});
