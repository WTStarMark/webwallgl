	vec4 c = texSample2D(g_Texture0, v_TexCoord);
	c.rgb = mix(c.rgb, g_FxColor, g_FxAmount);
	gl_FragColor = c;
