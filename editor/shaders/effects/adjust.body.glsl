	vec4 c = texSample2D(g_Texture0, v_TexCoord);
	vec3 rgb = c.rgb + vec3(g_FxBrightness, g_FxBrightness, g_FxBrightness);
	rgb = (rgb - vec3(0.5, 0.5, 0.5)) * g_FxContrast + vec3(0.5, 0.5, 0.5);
	float l = dot(rgb, vec3(0.299, 0.587, 0.114));
	rgb = mix(vec3(l, l, l), rgb, g_FxSaturation);
	gl_FragColor = vec4(clamp(rgb, 0.0, 1.0), c.a);
