	vec4 c = texSample2D(g_Texture0, v_TexCoord);
	c.a *= 1.0 - g_FxAmount * (0.5 + 0.5 * sin(g_Time * g_FxSpeed * 6.2831853));
	gl_FragColor = c;
