	vec2 cell = max(g_FxSize, 1.0) / max(g_Texture0Resolution.xy, vec2(1.0, 1.0));
	vec2 uv = (floor(v_TexCoord / cell) + vec2(0.5, 0.5)) * cell;
	gl_FragColor = texSample2D(g_Texture0, uv);
