// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { sanitizeClient } from './sanitizeClient';

describe('sanitizeClient', () => {
  it('keeps what the toolbar makes', () => {
    const html = '<div style="text-align:center"><b>B</b><i>i</i><u>u</u><strike>s</strike><span style="font-size:large">big</span></div><ul><li>a</li></ul><ol><li>b</li></ol><blockquote>q</blockquote><p style="margin-left:48px">in</p>';
    expect(sanitizeClient(html)).toBe(html);
  });
  it('removes scripts, handlers, frames, images and forms, with their contents', () => {
    expect(sanitizeClient('<p onclick="x()">hi</p><script>alert(1)</script><style>p{}</style><iframe src="//e"></iframe><img src=x onerror=alert(1)><form><input></form><svg onload=alert(1)><a>t</a></svg>')).toBe('<p>hi</p>');
  });
  it('unwraps unknown tags but keeps their text', () => {
    expect(sanitizeClient('<font color="red">hello</font> <h1>title</h1>')).toBe('hello title');
  });
  it('only lets safe links through, and adds rel/target', () => {
    expect(sanitizeClient('<a href="https://ok.test/x">ok</a>')).toBe('<a href="https://ok.test/x" target="_blank" rel="noopener noreferrer nofollow">ok</a>');
    for (const href of ['javascript:alert(1)', '  JaVaScRiPt:alert(1)', 'data:text/html;base64,AA', '//evil.test', '/relative']) {
      expect(sanitizeClient(`<a href="${href}">x</a>`), href).toBe('<a>x</a>');
    }
  });
  it('drops styles outside the allowed values', () => {
    expect(sanitizeClient('<div style="position:fixed;text-align:center;font-size:99px;margin-left:500px;color:red;background:url(javascript:1)">x</div>')).toBe('<div style="text-align:center">x</div>');
    expect(sanitizeClient('<p style="margin-left:120px">a</p><p style="margin-left:121px">b</p>')).toBe('<p style="margin-left:120px">a</p><p>b</p>');
  });
  it('escapes text so it cannot turn back into markup', () => {
    expect(sanitizeClient('a &lt;img src=x onerror=alert(1)&gt; b')).toBe('a &lt;img src=x onerror=alert(1)&gt; b');
  });
});
