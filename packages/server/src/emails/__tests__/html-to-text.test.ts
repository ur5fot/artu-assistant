import { describe, it, expect } from 'vitest';
import { htmlToText } from '../html-to-text.js';

describe('htmlToText', () => {
  it('removes simple tags and keeps text', () => {
    expect(htmlToText('<p>Hello, world</p>')).toBe('Hello, world');
  });

  it('strips <!DOCTYPE>, <html>, <head> wrappers', () => {
    const html = '<!DOCTYPE html><html lang="en"><head><title>x</title></head><body><p>Hi</p></body></html>';
    const out = htmlToText(html);
    expect(out).not.toContain('<');
    expect(out).not.toMatch(/DOCTYPE/i);
    expect(out).toContain('Hi');
  });

  it('decodes named entities', () => {
    expect(htmlToText('Tom &amp; Jerry &lt;3 &gt; &quot;q&quot; &apos;a&apos;')).toBe(
      'Tom & Jerry <3 > "q" \'a\'',
    );
  });

  it('decodes &nbsp; as a space', () => {
    expect(htmlToText('a&nbsp;b')).toBe('a b');
  });

  it('decodes numeric decimal and hex entities', () => {
    expect(htmlToText('&#39;quote&#39; &#8364; &#x20AC;')).toBe("'quote' € €");
  });

  it('drops <script> and its contents', () => {
    const html = '<div>Visible<script>var x = 1; alert("nope")</script></div>';
    const out = htmlToText(html);
    expect(out).toContain('Visible');
    expect(out).not.toContain('alert');
    expect(out).not.toContain('var x');
  });

  it('drops <style> and its contents', () => {
    const html = '<style>.a{color:red}</style><p>Body</p>';
    const out = htmlToText(html);
    expect(out).toContain('Body');
    expect(out).not.toContain('color:red');
  });

  it('drops HTML comments', () => {
    expect(htmlToText('<!-- hidden --><p>Shown</p>')).toBe('Shown');
  });

  it('converts <br> and block ends to newlines', () => {
    expect(htmlToText('Line1<br>Line2<br/>Line3')).toBe('Line1\nLine2\nLine3');
    expect(htmlToText('<p>one</p><p>two</p>')).toBe('one\ntwo');
  });

  it('collapses excess blank lines and horizontal whitespace', () => {
    const html = '<p>a</p>\n\n\n\n<p>   b    c   </p>';
    expect(htmlToText(html)).toBe('a\n\nb c');
  });

  it('handles a real-world DOCTYPE marketing mail without leaking tags', () => {
    const html = `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01//EN">
      <html lang="uk">
      <head><meta charset="utf-8"><style>body{margin:0}</style></head>
      <body>
        <table><tr><td><h1>GERC.UA</h1></td></tr>
        <tr><td><p>Ваш рахунок за травень: <b>123,45&nbsp;грн</b></p></td></tr></table>
        <script>track();</script>
      </body></html>`;
    const out = htmlToText(html);
    expect(out).not.toContain('<');
    expect(out).not.toContain('track()');
    expect(out).not.toContain('margin:0');
    expect(out).toContain('GERC.UA');
    expect(out).toContain('Ваш рахунок за травень');
    expect(out).toContain('123,45 грн');
  });

  it('returns plain text with no tags unchanged', () => {
    expect(htmlToText('Just a plain sentence.')).toBe('Just a plain sentence.');
  });

  it('does not corrupt a bare ampersand or less-than in plain text', () => {
    // No trailing `;` → not a valid entity, left intact.
    expect(htmlToText('R&D budget is 5 < 10')).toBe('R&D budget is 5 < 10');
  });

  it('returns empty string for empty input', () => {
    expect(htmlToText('')).toBe('');
  });

  it('leaves an invalid numeric entity untouched', () => {
    expect(htmlToText('&#xZZ; &#999999999999;')).toBe('&#xZZ; &#999999999999;');
  });
});
