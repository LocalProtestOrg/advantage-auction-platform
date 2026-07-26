// faq-schema.js — emits FAQPage JSON-LD structured data from the page's own <details><summary> Q&A.
// Keeps the structured data always in sync with the visible content (no duplicated text) and gives
// buyer-faq / seller-faq eligibility for FAQ rich results. Include once, after the FAQ markup.
(function () {
  'use strict';
  function build() {
    var items = document.querySelectorAll('details.faq-item');
    if (!items.length) return;
    var faqs = [];
    items.forEach(function (d) {
      var q = d.querySelector('summary');
      var a = d.querySelector('.faq-body');
      if (!q || !a) return;
      var question = (q.textContent || '').trim();
      var answer = (a.textContent || '').replace(/\s+/g, ' ').trim();
      if (!question || !answer) return;
      faqs.push({ '@type': 'Question', name: question,
        acceptedAnswer: { '@type': 'Answer', text: answer } });
    });
    if (!faqs.length) return;
    var s = document.createElement('script');
    s.type = 'application/ld+json';
    s.textContent = JSON.stringify({ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: faqs });
    document.head.appendChild(s);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();
})();
