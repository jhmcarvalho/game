class Sprite {
    constructor({ position, velocity, image, frames = { max: 1 }, sprites, name }) {
        this.position = position
        this.image = image
        this.frames = { ...frames, val: 0, elapsed: 0 }
        this.image.onload = () => {
            this.width = this.image.width / this.frames.max
            this.height = this.image.height
        }
        // Fallback if image already loaded
        if (this.image.complete) {
            this.width = this.image.width / this.frames.max
            this.height = this.image.height
        }
        this.moving = false
        this.sprites = sprites
        this.name = name
    }

    draw() {
        c.drawImage(
            this.image,
            this.frames.val * this.width,
            0,
            this.image.width / this.frames.max,
            this.image.height,
            this.position.x,
            this.position.y,
            this.image.width / this.frames.max,
            this.image.height,
        )

        // Draw name above character
        if (this.name) {
            c.font = '14px Arial'
            const textWidth = c.measureText(this.name).width
            const padding = 4

            // Background box for the name
            c.fillStyle = 'rgba(0, 0, 0, 0.5)'
            c.fillRect(
                this.position.x + this.width / 2 - textWidth / 2 - padding,
                this.position.y - 25,
                textWidth + padding * 2,
                20
            )

            // Name text
            c.fillStyle = 'white'
            c.fillText(
                this.name,
                this.position.x + this.width / 2 - textWidth / 2,
                this.position.y - 10
            )
        }

        if (!this.moving) return
        if (this.frames.max > 1) {
            this.frames.elapsed++
        }
        if (this.frames.elapsed % 10 == 0) {
            if (this.frames.val < this.frames.max - 1)
                this.frames.val++
            else this.frames.val = 0
        }
    }
}


class Boundary {
    static width = 48
    static height = 48
    constructor({ position }) {
        this.position = position
        this.width = 48
        this.height = 48
    }

    draw() {
        c.fillStyle = 'rgba(255, 0, 0, 0.0'
        c.fillRect(this.position.x, this.position.y, this.width, this.height)
    }
}