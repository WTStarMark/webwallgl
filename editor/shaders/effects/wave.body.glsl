	vec2 uv = v_TexCoord;
	uv.x += sin((uv.y * g_FxFrequency + g_Time * g_FxSpeed) * 6.2831853) * g_FxAmplitude;
	vec4 c = texSample2D(g_Texture0, uv);
	c *= step(0.0, uv.x) * step(uv.x, 1.0);
	gl_FragColor = c;
