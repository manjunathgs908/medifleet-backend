/**
 * services/seoSchemaValidator.js
 * ============================================================
 * Shape checks for the JSON-LD the generator assembles.
 *
 * This was previously only enforced at render time, in savelife-web's
 * lib/guides.js, which drops invalid nodes on the way out. That is the right
 * last line of defence and the wrong only one: a reviewer could approve an
 * article whose structured data was unusable, and nothing would say so until
 * the page quietly shipped without a rich result. Approval is the moment a
 * human takes responsibility for a page, so it is the moment the page has to
 * be checkable.
 *
 * The rules are deliberately identical to the render-time ones. If they ever
 * disagree, the generator is the one that decides whether an article can be
 * approved, and the renderer is the one that decides what ships -- two
 * different answers to "is this valid" is worse than either answer alone.
 *
 * These are shape checks, not a schema.org validator. They catch the ways a
 * generated node actually goes wrong: a missing @type, a required property
 * that is empty, an FAQ list with no questions in it, a breadcrumb whose
 * items are not a list.
 * ============================================================
 */
'use strict';

const REQUIRED_BY_TYPE = {
  Article: ['headline'],
  BlogPosting: ['headline'],
  Service: ['name'],
  FAQPage: ['mainEntity'],
  BreadcrumbList: ['itemListElement'],
};

/**
 * Returns [] when the node is fine, or a list of human-readable reasons.
 * Reasons are written for the reviewer looking at the SEO Studio, not for a
 * log: they name the node and say what is missing.
 */
function nodeErrors(node, index) {
  const at = `node ${index + 1}`;

  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    return [`${at}: not an object`];
  }

  const type = node['@type'];
  if (!type || typeof type !== 'string') {
    return [`${at}: missing @type`];
  }

  const errors = [];
  for (const key of REQUIRED_BY_TYPE[type] || []) {
    const value = node[key];
    if (value === undefined || value === null || value === '') {
      errors.push(`${at} (${type}): ${key} is missing or empty`);
      continue;
    }
    // An FAQPage with mainEntity: [] is a rich-result candidate with nothing
    // in it -- an error rather than an empty section.
    if (Array.isArray(value) && value.length === 0) {
      errors.push(`${at} (${type}): ${key} is an empty list`);
    }
  }

  if (type === 'FAQPage') {
    const questions = node.mainEntity;
    if (!Array.isArray(questions)) {
      errors.push(`${at} (FAQPage): mainEntity must be a list of questions`);
    } else if (!questions.every((q) => q?.name && q?.acceptedAnswer?.text)) {
      errors.push(`${at} (FAQPage): every question needs a name and an acceptedAnswer.text`);
    }
  }

  if (type === 'BreadcrumbList') {
    const items = node.itemListElement;
    if (!Array.isArray(items)) {
      errors.push(`${at} (BreadcrumbList): itemListElement must be a list`);
    } else if (!items.every((i) => i?.position && i?.name)) {
      errors.push(`${at} (BreadcrumbList): every item needs a position and a name`);
    }
  }

  return errors;
}

/**
 * Validates the whole assembled block.
 *
 * BreadcrumbList is validated here but NOT required, and the renderer drops
 * the stored one in favour of the trail the page actually shows. Both remain
 * true: the generator may not store a malformed breadcrumb, and the page may
 * not describe navigation the visitor cannot see.
 */
function validateJsonLd(jsonLd) {
  const nodes = Array.isArray(jsonLd) ? jsonLd : jsonLd ? [jsonLd] : [];

  if (!nodes.length) return ['no JSON-LD was assembled'];

  const errors = nodes.flatMap((node, i) => nodeErrors(node, i));

  // A page whose only structured data is a breadcrumb has no structured data:
  // the renderer discards the stored breadcrumb, so nothing would ship.
  const types = nodes.map((n) => (n && typeof n === 'object' ? n['@type'] : null)).filter(Boolean);
  const meaningful = types.filter((t) => t !== 'BreadcrumbList');
  if (!errors.length && !meaningful.length) {
    errors.push('only a BreadcrumbList was assembled; the rendered page drops it, leaving no structured data');
  }

  return errors;
}

module.exports = { validateJsonLd, nodeErrors, REQUIRED_BY_TYPE };
