import { create } from 'zustand'

const useStore = create((set, get) => ({
  val: 'a',
  update: () => {
    set({ val: 'b' })
    console.log(get().val)
  }
}))

useStore.getState().update()
