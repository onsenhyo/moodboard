import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyInput } from '../src/classify.js';

test('youtube 형태들', () => {
  for (const u of ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3', 'https://youtu.be/dQw4w9WgXcQ', 'https://youtube.com/shorts/dQw4w9WgXcQ', 'https://m.youtube.com/watch?v=dQw4w9WgXcQ'])
    assert.deepEqual(classifyInput(u), { kind: 'youtube', videoId: 'dQw4w9WgXcQ' });
});
test('pinterest 지역 도메인', () => {
  for (const u of ['https://www.pinterest.com/pin/123456789/', 'https://kr.pinterest.com/pin/123456789/', 'https://pinterest.co.kr/pin/123456789'])
    assert.deepEqual(classifyInput(u), { kind: 'pinterest', pinId: '123456789' });
});
test('pin.it은 pin_short', () => assert.equal(classifyInput('https://pin.it/abc').kind, 'pin_short'));
test('기타 링크·http', () => assert.deepEqual(classifyInput(' http://example.com/a '), { kind: 'link', url: 'http://example.com/a' }));
test('망가진 youtube는 link', () => assert.equal(classifyInput('https://youtu.be/?').kind, 'link'));
test('글', () => assert.deepEqual(classifyInput('빛이 부서지는 오후'), { kind: 'text', text: '빛이 부서지는 오후' }));
test('빈 입력', () => assert.equal(classifyInput('   '), null));
