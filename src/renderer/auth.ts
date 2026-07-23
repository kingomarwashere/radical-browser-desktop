declare const auth: {
  onInfo: (fn: (d: { host: string; realm: string; isProxy: boolean }) => void) => void
  submit: (username: string, password: string) => void
  cancel: () => void
}

const $id = (id: string) => document.getElementById(id)!
const userIn = $id('user') as HTMLInputElement
const passIn = $id('pass') as HTMLInputElement

auth.onInfo(d => {
  $id('title').textContent = d.isProxy ? 'Proxy authentication' : `Sign in to ${d.host}`
  $id('sub').textContent = d.realm ? `Realm: ${d.realm}` : (d.isProxy ? 'The proxy requires a username and password.' : 'This site requires a username and password.')
  userIn.focus()
})

function submit() { auth.submit(userIn.value, passIn.value) }

$id('ok').addEventListener('click', submit)
$id('cancel').addEventListener('click', () => auth.cancel())
document.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); submit() }
  else if (e.key === 'Escape') { e.preventDefault(); auth.cancel() }
})
