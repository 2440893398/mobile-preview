import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 这台机器上真的攒出过 7 个没人关的静态服务器，最老的活了三天；用户点开一条
// 新链接，看到的是上一个任务留在那个端口上的旧页面。mp 自己端页面就是为了把
// 「起服务器」和「关服务器」这两件事捆在一个进程上。
//
// 这一组测的是那个服务器本身：给对的东西、不给不该给的东西。

const { createStaticServer, resolveServeTarget } = await import('../src/static.js')

function site() {
  const dir = mkdtempSync(join(tmpdir(), 'mp-static-'))
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>首页</title>')
  writeFileSync(join(dir, 'report.html'), '<!doctype html><title>报告</title>')
  writeFileSync(join(dir, 'app.css'), 'body{color:red}')
  mkdirSync(join(dir, 'sub'))
  writeFileSync(join(dir, 'sub', 'deep.txt'), 'deep')
  writeFileSync(join(dir, '..', 'outside-secret.txt'), 'nope')
  return dir
}

async function serving(target, fn) {
  const server = createStaticServer(target)
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    return await fn(base)
  } finally {
    server.close()
  }
}

test('给目录：/ 出 index.html，子路径按扩展名给类型，不许缓存', async () => {
  const dir = site()
  await serving(resolveServeTarget(dir), async (base) => {
    const home = await fetch(`${base}/`)
    assert.equal(home.status, 200)
    assert.match(home.headers.get('content-type'), /text\/html/)
    assert.equal(home.headers.get('cache-control'), 'no-store', '预览要的是这一刻的页面，不是缓存里的')
    assert.match(await home.text(), /首页/)

    const css = await fetch(`${base}/app.css`)
    assert.match(css.headers.get('content-type'), /text\/css/)
    assert.equal(await css.text(), 'body{color:red}')

    assert.equal((await fetch(`${base}/sub/deep.txt`)).status, 200)
    assert.equal((await fetch(`${base}/sub/`)).status, 404, '没有 index.html 的目录不该列出内容')
    assert.equal((await fetch(`${base}/nope.html`)).status, 404)
  })
})

test('爬不出根目录：编码过的 ../ 也不行', async () => {
  const dir = site()
  await serving(resolveServeTarget(dir), async (base) => {
    for (const p of ['/%2e%2e/outside-secret.txt', '/sub/%2e%2e/%2e%2e/outside-secret.txt']) {
      const res = await fetch(`${base}${p}`)
      assert.equal(res.status, 404, `${p} 不该能读到根目录外面的文件`)
    }
  })
})

test('给单个文件：只给这一个，同目录的邻居一律 404', async () => {
  const dir = site()
  await serving(resolveServeTarget(join(dir, 'report.html')), async (base) => {
    const root = await fetch(`${base}/`)
    assert.equal(root.status, 200)
    assert.match(await root.text(), /报告/)
    assert.equal((await fetch(`${base}/report.html`)).status, 200)
    // --serve ./docs/report.html 不能顺手把整个 docs 挂到公网 url 上。
    assert.equal((await fetch(`${base}/index.html`)).status, 404)
    assert.equal((await fetch(`${base}/app.css`)).status, 404)
  })
})

test('只认 GET 和 HEAD', async () => {
  const dir = site()
  await serving(resolveServeTarget(dir), async (base) => {
    const head = await fetch(`${base}/`, { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(await head.text(), '')

    const post = await fetch(`${base}/`, { method: 'POST' })
    assert.equal(post.status, 405)
  })
})

test('路径不存在时，--serve 当场就说，而不是起一个空壳预览', () => {
  assert.throws(
    () => resolveServeTarget(join(tmpdir(), 'mp-static-does-not-exist-9ab3')),
    /no such file or directory/,
  )
})

// 注释说「realpath 之后再查一次」，代码里其实没查：根目录里一个指向 ~/.ssh
// 的链接，就能把私钥从公网链接发出去。
test('根目录里的符号链接指到外面：不给', async (t) => {
  const dir = site()
  const outside = mkdtempSync(join(tmpdir(), 'mp-static-out-'))
  writeFileSync(join(outside, 'id_rsa'), 'PRIVATE')
  const probes = []
  try {
    // junction：Windows 上不要管理员权限也建得出来
    symlinkSync(outside, join(dir, 'data'), 'junction')
    probes.push('/data/id_rsa')
  } catch {
    // 下面一起判断
  }
  try {
    symlinkSync(join(outside, 'id_rsa'), join(dir, 'key.txt'), 'file')
    probes.push('/key.txt')
  } catch {
    // Windows 非管理员建不了文件链接
  }
  if (!probes.length) {
    t.skip('这台机器建不了符号链接')
    return
  }
  await serving(resolveServeTarget(dir), async (base) => {
    for (const p of probes) {
      const res = await fetch(`${base}${p}`)
      assert.equal(res.status, 404, p)
      assert.doesNotMatch(await res.text(), /PRIVATE/)
    }
  })
})

test('根目录里指向里面的符号链接照常给', async (t) => {
  const dir = site()
  try {
    // junction：Windows 上不要管理员权限也建得出来
    symlinkSync(join(dir, 'sub'), join(dir, 'alias'), 'junction')
  } catch (err) {
    t.skip(`这台机器建不了符号链接：${err.code}`)
    return
  }
  await serving(resolveServeTarget(dir), async (base) => {
    assert.equal(await (await fetch(`${base}/alias/deep.txt`)).text(), 'deep')
  })
})

// /docs 直接给 docs/index.html 的话，页面里的 style.css 会按 /style.css 去要。
test('目录不带结尾斜杠：先跳到带斜杠的地址，保留查询串', async () => {
  const dir = site()
  mkdirSync(join(dir, 'docs'))
  writeFileSync(join(dir, 'docs', 'index.html'), '<link href="style.css">')
  await serving(resolveServeTarget(dir), async (base) => {
    const res = await fetch(`${base}/docs?x=1`, { redirect: 'manual' })
    assert.equal(res.status, 301)
    assert.equal(new URL(res.headers.get('location'), `${base}/docs?x=1`).href, `${base}/docs/?x=1`)
    assert.match(await (await fetch(`${base}/docs/`)).text(), /style\.css/)
  })
})
