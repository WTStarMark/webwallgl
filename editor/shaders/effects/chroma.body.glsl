	vec2 d = vec2(cos(g_FxAngle), sin(g_FxAngle)) * g_FxAmount;
	vec4 r = texSample2D(g_Texture0, v_TexCoord + d);
	vec4 c = texSample2D(g_Texture0, v_TexCoord);
	vec4 b = texSample2D(g_Texture0, v_TexCoord - d);
	gl_FragColor = vec4(r.r, c.g, b.b, max(max(r.a, c.a), b.a));
