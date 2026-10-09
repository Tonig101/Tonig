$ErrorActionPreference = 'Stop'
$root  = 'D:\Program Files\PythonStudy\Kards'
$pf = Join-Path $root 'index.html'
$t  = [IO.File]::ReadAllText($pf)

# 键：旧字面量；值：新字面量（PS 单引号串用 '' 转义单品引号）
$map = @{
  '断水.jpg'               = '断水.png'
  '闪电战.jpg'             = '闪电战.png'
  '战术打击.jpg'           = '战术打击.png'
  '侦察队.jpg'             = '侦察队.png'
  'IS-3.jpg'               = 'IS-3.png'
  '不惜代价.jpg'           = '不惜代价.png'
  '冬季攻势.jpg'           = '冬季攻势.png'
  '钢铁洪流.jpg'           = '钢铁洪流.png'
  '工人们联合.jpg'         = '工人们联合.png'
  '近卫第8步兵师.jpg'      = '近卫第8步兵师.png'
  '人海战术.jpg'           = '人海战术.png'
  '血红的镰刀.jpg'         = '血红的镰刀.png'
  '雷达警报.jpg'           = '雷达警报.png'
  '牛津.jpg'               = '牛津.png'
  '拖延战术.jpg'           = '拖延战术.png'
  '战争机器.jpg'           = '战争机器.png'
  '战争债券.jpg'           = '战争债券.png'
  'images/UI/被守护.jpg'   = 'images/UI/被守护.png'
  'images/UI/守护.jpg'     = 'images/UI/守护.png'
  'images/UI/闪击.jpg'     = 'images/UI/闪击.png'
  'images/UI/冲击.jpg'     = 'images/UI/冲击.png'
  'images/UI/伏击.jpg'     = 'images/UI/伏击.png'
  'images/UI/烟幕.jpg'     = 'images/UI/烟幕.png'
  'images/UI/压制.jpg'     = 'images/UI/压制.png'
  'images/UI/重甲''+lv+''.jpg' = 'images/UI/重甲''+lv+''.png'
  'images/Germany/D_I_MG42Team.png'       = 'images/Germany/D_I_Volksgrenadier.jpg'
  'images/Japan/丛林突袭.png'             = 'images/Japan/扩张.jpg'
  'images/Soviet_Union/S_I_Partisan.png'  = 'images/Soviet_Union/S_I_RedArmy.jpg'
  'images/Soviet_Union/近卫步兵.jpg'      = 'images/Soviet_Union/S_I_GuardsFlag.jpg'
  'images/UK/B_I_DesertRat.png'           = 'images/UK/B_I_BritInfantry.jpg'
  'images/UK/B_I_Paratrooper.png'         = 'images/UK/苏格兰伞兵.jpg'
}

foreach ($k in $map.Keys) {
  if ($t.Contains($k)) { $t = $t.Replace($k, $map[$k]) }
  else { Write-Output ('[空缺] 未匹配: ' + $k) }
}
[IO.File]::WriteAllText($pf, $t, (New-Object System.Text.UTF8Encoding($false)))
Write-Output ('完成替换: ' + $map.Count + ' 项已写回 ')

# 校验：抽取所有引用的 images 路径，比对本地是否存在
$rx = [regex]'images/[A-Za-z0-9_\-./\u4e00-\u9fa5]+'
$refs = $rx.Matches($t) | ForEach-Object { $_.Value } | Sort-Object -Unique
$missing = @()
foreach ($r in $refs) {
  $rel = $r -replace '^images/',''
  if (-not (Test-Path (Join-Path (Join-Path $root 'images') $rel))) { $missing += $r }
}
Write-Output ('总引用(去重): ' + $refs.Count)
if ($missing.Count -eq 0) { Write-Output '== 校验通过：所有图片引用均命中本地文件 ==' }
else { Write-Output '== 仍缺失的引用 =='; $missing | Sort-Object }