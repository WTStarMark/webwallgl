	vec4 c = texSample2D(g_Texture0, v_TexCoord);
	float d = length(v_TexCoord - vec2(0.5, 0.5)) * 1.41421356;
	float v = 1.0 - smoothstep(g_FxRadius - g_FxSoftness, g_FxRadius, d);
	c.rgb *= mix(1.0, v, g_FxStrength);
	gl_FragColor = c;
