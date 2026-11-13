import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatMessageBody } from '../src/whatsapp/media-format.js';

test('formatMessageBody renders plain text and non-text media labels without downloading', () => {
  assert.equal(formatMessageBody({ type: 'chat', body: 'Fiyat nedir?' }), 'Fiyat nedir?');
  assert.equal(formatMessageBody({ type: 'ptt', duration: 18, body: '' }), '[Sesli mesaj, 18 sn]');
  assert.equal(formatMessageBody({ type: 'image', body: 'Bu ürün stokta mı?' }), '[Fotoğraf] Bu ürün stokta mı?');
  assert.equal(
    formatMessageBody({ type: 'document', filename: 'teklif.pdf', body: '' }),
    '[Dosya: teklif.pdf]'
  );
  assert.equal(formatMessageBody({ type: 'video', duration: 9, body: '' }), '[Video, 9 sn]');
});

test('formatMessageBody handles additional media types, missing metadata, and whatsapp-web.js raw fields', () => {
  assert.equal(formatMessageBody(null), '');
  assert.equal(formatMessageBody({ type: 'audio', duration: '42', body: '   Detaylar  ' }), '[Sesli mesaj, 42 sn] Detaylar');
  assert.equal(formatMessageBody({ type: 'ptt', body: '' }), '[Sesli mesaj]');
  assert.equal(formatMessageBody({ type: 'video', body: '  Tanıtım  ' }), '[Video] Tanıtım');
  assert.equal(formatMessageBody({ type: 'document', body: 'Ektedir' }), '[Dosya] Ektedir');
  assert.equal(
    formatMessageBody({ type: 'document', _data: { filename: 'fatura.pdf' }, body: '' }),
    '[Dosya: fatura.pdf]'
  );
  assert.equal(formatMessageBody({ type: 'sticker', body: '' }), '[Çıkartma]');
  assert.equal(formatMessageBody({ type: 'location', body: '' }), '[Konum]');
  assert.equal(formatMessageBody({ type: 'location', body: 'Ofis adresi' }), '[Konum] Ofis adresi');
  assert.equal(
    formatMessageBody({ type: 'location', body: '/9j/4AAQSkZJRgABAQAAAQABAAD/' + 'A'.repeat(120) }),
    '[Konum]'
  );
});
