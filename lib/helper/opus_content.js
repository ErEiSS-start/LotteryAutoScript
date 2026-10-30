// Extract only the article body, not author IDs, statistics or recommended posts.
function parseOpusContent(response, expectedId) {
    const item = response?.data?.item;
    if (response?.code !== 0 || String(item?.id_str || '') !== String(expectedId)
        || !Array.isArray(item?.modules)) return null;
    const bodies = item.modules.filter(m => m?.module_type === 'MODULE_TYPE_CONTENT'
        && Array.isArray(m?.module_content?.paragraphs));
    if (!bodies.length) return null;
    const bodyFields = ['text', 'pic', 'line', 'list', 'link_card', 'code', 'heading', 'blockquote'];
    if (bodies.some(m => m.module_content.paragraphs.some(p => !p || typeof p !== 'object'
        || !bodyFields.some(key => p[key] != null)))) return null;
    const text = [];
    const children = ['nodes', 'word', 'rich', 'text', 'paragraphs', 'items', 'list',
        'heading', 'blockquote', 'code', 'link_card', 'link'];
    function visit(value, depth = 0) {
        if (!value || typeof value !== 'object' || depth > 15) return;
        if (Array.isArray(value)) { value.forEach(v => visit(v, depth + 1)); return; }
        for (const key of ['words', 'text', 'orig_text', 'raw_text', 'show_text', 'content', 'code']) {
            if (typeof value[key] === 'string') text.push(value[key]);
        }
        for (const key of ['jump_url', 'url', 'link']) {
            if (typeof value[key] !== 'string') continue;
            try {
                const url = new URL(value[key], 'https://www.bilibili.com/');
                if (url.hostname === 'bilibili.com' || url.hostname.endsWith('.bilibili.com')
                    || url.hostname === 'b23.tv') text.push(url.href);
            } catch (_) { /* Invalid body links are not content identifiers. */ }
        }
        for (const key of children) visit(value[key], depth + 1);
    }
    bodies.forEach(m => visit(m.module_content.paragraphs));
    const escaped = text.join('\n').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    // A structurally valid empty/image-only article is still a successfully read source.
    return `<div class="article-content">${escaped}</div>`;
}
module.exports = { parseOpusContent };
