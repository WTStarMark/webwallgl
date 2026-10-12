	vec2 px = g_FxWidth / max(g_Texture0Resolution.xy, vec2(1.0, 1.0));
	vec4 c = texSample2D(g_Texture0, v_TexCoord);
	float a = 0.0;
	for (int i = 0; i < 16; i++) {
		float t = float(i) * 0.39269908;
		a = max(a, texSample2D(g_Texture0, v_TexCoord + vec2(cos(t), sin(t)) * px).a);
	}
	gl_FragColor = vec4(mix(g_FxColor, c.rgb, c.a), max(c.a, a));
