$root='D:\Program Files\PythonStudy\Kards'
$pf =Join-Path $root 'index.html'
$t  =[IO.File]::ReadAllText($pf)
$rx =[regex]::new('images/[A-Za-z0-9_\-./\u4e00-\u9fa5]+')
$refs=$rx.Matches($t)|ForEach-Object{$_.Value}|Sort-Object -Unique
$img=Join-Path $root 'images'
$lines=@()
foreach($r in $refs){
  $rel=$r.Substring(7)
  if(Test-Path (Join-Path $img $rel)){ $lines+=$r }
}
[IO.File]::WriteAllLines((Join-Path $root 'imglist.txt'),$lines,(New-Object System.Text.UTF8Encoding($false)))
Write-Output ('待提交图片数(本地存在): '+$lines.Count)
# 预览前20条目，供确认
$lines | Select-Object -First 20 | ForEach-Object { Write-Output ('  '+$_) }