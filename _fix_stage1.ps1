$root = 'D:\Program Files\PythonStudy\Kards'
$pf   = Join-Path $root 'index.html'
$img  = Join-Path $root 'images'
$t    = [IO.File]::ReadAllText($pf)

# 阶段1：任何 "images/xxx.jpg" 引用，若同目录存在同名 .png 则改为 .png
$rx  = [regex]::new("([""'])(images/[^\x22\x27]+)\.jpg([\x22\x27])")
$eval = [System.Text.MatchEvaluator]{ param($m)
  $prefix = $m.Groups[1].Value
  $base   = $m.Groups[2].Value   # images/...
  $suffix = $m.Groups[3].Value
  $rel    = $base.Substring(7)   # 去掉 'images/'
  if (Test-Path (Join-Path $img ($rel + '.png'))) {
    return $prefix + $base + '.png' + $suffix
  }
  return $m.Value
}
$t = $rx.Replace($t, $eval)

# 阶段2：重甲图标拼接 images/UI/重甲'+lv+'.jpg  -> .png
$beforeH = $t.Contains('images/UI/') -and $t.Contains("'+lv+'.jpg")
$t = [regex]::Replace($t, '(images/UI/\u91cd\u7532\x27\+lv\+\x27)\.jpg', '$1.png')

[IO.File]::WriteAllText($pf, $t, (New-Object System.Text.UTF8Encoding($false)))
Write-Output 'stage1 done'
Write-Output ('重甲lv片段需替换: ' + $beforeH)

# ===== 校验：剩余缺失引用 =====
$refsx = [regex]::new('images/[A-Za-z0-9_\-./\u4e00-\u9fa5]+')
$refs = $refsx.Matches($t) | ForEach-Object { $_.Value } | Sort-Object -Unique
$missing = @()
foreach ($r in $refs) {
  $rel = $r.Substring(7)
  if (-not (Test-Path (Join-Path $img $rel))) { $missing += $r }
}
Write-Output ('总引用(去重): ' + $refs.Count)
if ($missing.Count -eq 0) {
  Write-Output '== stage1 校验通过：所有 .jpg/.png 引用均命中本地文件 =='
} else {
  Write-Output '== stage1 后仍缺失的引用（将由手动映射处理） =='
  $missing | Sort-Object | ForEach-Object { Write-Output ('  ' + $_) }
}