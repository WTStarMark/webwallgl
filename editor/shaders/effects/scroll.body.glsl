	vec2 uv = fract(v_TexCoord + vec2(g_FxSpeedx, g_FxSpeedy) * g_Time);
	gl_FragColor = texSample2D(g_Texture0, uv);
