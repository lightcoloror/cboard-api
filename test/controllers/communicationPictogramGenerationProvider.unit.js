'use strict';

const chai = require('chai');
const sharp = require('sharp');
const {
  buildAacPictogramPrompt,
  createCommunicationPictogramGenerationProvider,
  normalizeGenerationLabel
} = require('../../api/helpers/communicationPictogramGenerationProvider');

const expect = chai.expect;

async function createPng() {
  return sharp({
    create: {
      width: 32,
      height: 32,
      channels: 4,
      background: { r: 20, g: 160, b: 80, alpha: 1 }
    }
  })
    .png()
    .toBuffer();
}

describe('Communication pictogram generation provider', function() {
  it('reuses the configured AI client and returns a bounded private PNG', async function() {
    const requests = [];
    const png = await createPng();
    const provider = createCommunicationPictogramGenerationProvider({
      env: {
        AI_IMAGE_MODEL: 'gpt-image-1',
        AI_IMAGE_REQUEST_TIMEOUT_MS: '90000'
      },
      aiProvider: {
        provider: 'openai-compatible',
        baseUrl: 'https://images.example/v1',
        client: {
          images: {
            generate: async (body, options) => {
              requests.push({ body, options });
              return {
                data: [{ b64_json: png.toString('base64') }],
                usage: {
                  input_tokens: 12,
                  output_tokens: 20,
                  total_tokens: 32
                }
              };
            }
          }
        }
      }
    });

    const result = await provider.generate(
      { label: '紧急求助' },
      { userId: 'private-user-id' }
    );
    const normalized = await sharp(
      Buffer.from(result.imageBase64, 'base64')
    ).metadata();

    expect(result).to.include({
      mimeType: 'image/png',
      provider: 'openai-compatible',
      model: 'gpt-image-1',
      useScope: 'device-private',
      sourceStored: false,
      publicLicenseDeclared: false,
      providerTermsApply: true
    });
    expect(result.generationId).to.be.a('string').and.not.equal('');
    expect(result.usage.total_tokens).to.equal(32);
    expect(normalized).to.include({ format: 'png', width: 300, height: 300 });
    expect(requests[0].body).to.include({
      model: 'gpt-image-1',
      background: 'opaque',
      output_format: 'png',
      quality: 'low',
      size: '1024x1024'
    });
    expect(requests[0].body.user).to.match(/^[a-f0-9]{64}$/);
    expect(requests[0].body.user).not.to.equal('private-user-id');
    expect(requests[0].options.timeout).to.equal(90000);
    expect(requests[0].body.prompt).to.include('紧急求助');
    expect(requests[0].body.prompt).to.include('no written words');
  });

  it('requires an explicit image model and rejects malformed provider output', async function() {
    expect(
      createCommunicationPictogramGenerationProvider({
        env: {},
        aiProvider: { client: { images: { generate() {} } } }
      })
    ).to.equal(null);
    expect(normalizeGenerationLabel('  水\n\u0000杯  ')).to.equal('水 杯');
    expect(buildAacPictogramPrompt('水')).not.to.include('watermark allowed');

    const provider = createCommunicationPictogramGenerationProvider({
      env: { AI_IMAGE_MODEL: 'dall-e-3' },
      aiProvider: {
        provider: 'openai-compatible',
        baseUrl: 'https://images.example/v1',
        client: {
          images: { generate: async () => ({ data: [{ url: 'https://x' }] }) }
        }
      }
    });
    let error;
    try {
      await provider.generate({ label: '水' });
    } catch (caught) {
      error = caught;
    }
    expect(error).to.have.property('status', 502);
  });
});
