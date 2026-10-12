// wwgl/noise：wwglNoise(vec2) 值噪声；wwglFbm(vec2) 4 层分形（include 名 = wwgl/noise）
#include "wwgl/hash"
float wwglNoise(vec2 p) {
	vec2 i = floor(p);
	vec2 f = fract(p);
	vec2 u = f * f * (3.0 - 2.0 * f);
	return mix(mix(wwglHash12(i), wwglHash12(i + vec2(1.0, 0.0)), u.x),
	           mix(wwglHash12(i + vec2(0.0, 1.0)), wwglHash12(i + vec2(1.0, 1.0)), u.x), u.y);
}
float wwglFbm(vec2 p) {
	float v = 0.0;
	float a = 0.5;
	for (int i = 0; i < 4; i++) {
		v += a * wwglNoise(p);
		p *= 2.0;
		a *= 0.5;
	}
	return v;
}
