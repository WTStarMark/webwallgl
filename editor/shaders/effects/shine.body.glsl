	vec4 c = texSample2D(g_Texture0, v_TexCoord);
	float p = dot(v_TexCoord - vec2(0.5, 0.5), vec2(cos(g_FxAngle), sin(g_FxAngle))) + 0.5;
	float pos = fract(g_Time * g_FxSpeed) * (1.0 + 4.0 * g_FxWidth) - 2.0 * g_FxWidth;
	float band = 1.0 - smoothstep(0.0, g_FxWidth, abs(p - pos));
	c.rgb = clamp(c.rgb + g_FxColor * band * g_FxStrength, 0.0, 1.0);
	gl_FragColor = c;
