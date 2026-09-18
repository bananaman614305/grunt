import { Color } from 'three';

// One place to tune the sunset. Every value is sRGB hex; three converts to
// linear working space on construction, which is what the shaders expect.
export const palette = {
  zenith: new Color('#140a30'),
  upper: new Color('#3d1c58'),
  mid: new Color('#96396a'),
  low: new Color('#e7654a'),
  horizon: new Color('#ffb26b'),
  below: new Color('#1d0f2c'),
  sun: new Color('#ffcf8f'),
  sunCore: new Color('#fff5df'),
  waterNear: new Color('#170f2f'),
  cloudWarm: new Color('#ffc089'),
  cloudCool: new Color('#8a4a86'),
  cloudShade: new Color('#2a1136'),
  birdBody: new Color('#150a1e'),
  birdRim: new Color('#ffcf96'),
  birdBounce: new Color('#5b2a63'),
};
