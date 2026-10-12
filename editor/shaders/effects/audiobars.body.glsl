	vec4 base = texSample2D(g_Texture0, v_TexCoord);
	vec3 c = base.rgb;
	float cell = 1.0 / 32.0;
	float x = g_FxMirror > 0.5 ? abs(v_TexCoord.x * 2.0 - 1.0) : v_TexCoord.x;
	float d = abs(v_TexCoord.y - 0.5) * 2.0;
	float w = max(g_FxWidth * cell * 0.5, 0.001);
	for (int i = 0; i < 32; ++i) {
		float band = clamp((g_AudioSpectrum32Left[i] + g_AudioSpectrum32Right[i]) * 0.5 * g_FxScale, 0.0, 1.0);
		if (band > 0.0) {
			float bx = abs(x - (float(i) + 0.5) * cell);
			float barH = band * 0.5;
			float barX = 1.0 - smoothstep(w - g_FxSoftness * w, w, bx);
			float barY = 1.0 - smoothstep(barH - g_FxSoftness * 0.5, barH, d);
			c = mix(c, g_FxColor, clamp(barX * barY * g_FxAmount, 0.0, 1.0));
		}
	}
	gl_FragColor = vec4(c, base.a);
