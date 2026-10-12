	vec2 px = g_FxRadius / max(g_Texture0Resolution.xy, vec2(1.0, 1.0));
	vec4 c = texSample2D(g_Texture0, v_TexCoord);
	float a = 0.0;
	float wsum = 0.0;
	for (int i = -3; i <= 3; i++) {
		for (int j = -3; j <= 3; j++) {
			float w = exp(-float(i * i + j * j) / 8.0);
			a += texSample2D(g_Texture0, v_TexCoord + vec2(float(i), float(j)) * px).a * w;
			wsum += w;
		}
	}
	a = clamp(a / wsum * g_FxStrength, 0.0, 1.0);
	gl_FragColor = vec4(mix(g_FxColor, c.rgb, c.a), max(c.a, a));
